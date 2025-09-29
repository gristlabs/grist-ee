/**
 * This implements the configuration of notifications.
 *
 * They are stored in the table DocPrefs, which has (doc, user) records and (doc, null) records
 * with document defaults. Owner of a document can set notification preferences for the document,
 * and any user can override them (e.g. to subscribe or opt out).
 *
 * Only users explicitly listed in the document, or with access inherited from a parent resource,
 * may configure and receive notifications. If a user only has access by virtue of the doc being
 * "public", they cannot configure or receive notifications.
 *
 * In the future, we may want to support channels (e.g. in-app notifications, Slack, etc). This
 * can be done as additional configuration, with a list of channels to deliver notifications too.
 * I.e. owner could set which channels to deliver notifications on as the default for all
 * collaborators, and users may override (e.g. "email=no, in-app=yes, slack=yes").
 *
 *
 * TODO for testing:
 * - Check that actions 'Calculate' and 'UpdateCurrentTime' do not produce notifications.
 * - Check that anon edits do produce notifications.
 * - Check that form submissions do produce notifications.
 */
import { ApiError } from 'app/common/ApiError';
import { DocPrefs, FullDocPrefs } from 'app/common/Prefs';
import { FullUser, UserAccessData } from 'app/common/UserAPI';
import { setDefault } from 'app/common/gutil';
import { fillNotificationPrefs } from 'app/common/NotificationsConfigAPI';
import { NotificationPrefs, NotificationPrefsBundle } from 'app/common/NotificationPrefs';
import NotificationPrefsTI from 'app/common/NotificationPrefs-ti';
import { HomeDBCaches } from 'app/gen-server/lib/homedb/Caches';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { DocNotificationEvent, DocNotificationTemplateBase } from 'app/gen-server/lib/NotifierTypes';
import { BatchedJobs, Schedule } from 'app/server/lib/BatchedJobs';
import { OptDocSession } from 'app/server/lib/DocSession';
import { DocComment } from 'app/common/DocComments';
import { addUnsubscribeEndpoint, createUnsubscribeUrl } from 'app/gen-server/lib/DocNotificationUnsubscribes';
import type { GranularAccessForBundle } from 'app/server/lib/GranularAccess';
import { IDocNotificationManager } from 'app/server/lib/IDocNotificationManager';
import { INotifier } from 'app/server/lib/INotifier';
import { DocActionCategory, DocActionsDescription, sortDocActionCategories } from 'app/server/lib/describeDocActions';
import { expressWrap } from 'app/server/lib/expressWrap';
import { docEmailsQueue, GristBullMQJobs, GristJob } from 'app/server/lib/GristJobs';
import { GristServer } from 'app/server/lib/GristServer';
import log from 'app/server/lib/log';
import { getDocScope } from 'app/server/lib/requestUtils';
import express from 'express';
import { createCheckers } from "ts-interface-checker";
import flatten from 'lodash/flatten';
import pick from 'lodash/pick';

// Defines the schedule for notifications.
const schedulesByType: {[jobType: string]: Schedule} = {
  docChange: {
    type: 'email-docChange',
    firstDelay: 1 * 60_000,   // 1 minutes
    throttle: 5 * 60_000,     // 5 minutes
  },
  comment: {
    type: 'email-comments',
    firstDelay: 30_000,     // 30 seconds
    throttle: 3 * 60_000,   // 3 minutes
  }
};

// A hook for tests to override the default values.
export const Deps = { schedulesByType };

// Validation for NotificationPrefsBundle
const checkers = createCheckers(NotificationPrefsTI);
function checkFullNotificationPrefs(value: unknown): asserts value is NotificationPrefsBundle {
  checkers.NotificationPrefsBundle.strictCheck(value);
}
function testNotificationPrefs(value: unknown): value is NotificationPrefs {
  return checkers.NotificationPrefs.test(value);
}
function makeValidNotificationPrefs(value: unknown): NotificationPrefs {
  return testNotificationPrefs(value) ? value : {};
}

export interface NotificationPrefsWithUser extends NotificationPrefs {
  user: UserAccessData;
}

export function createDocNotificationManager(gristServer: GristServer): IDocNotificationManager|undefined {
  const jobs = gristServer.getJobs();
  if (!(jobs instanceof GristBullMQJobs)) {
    log.error("Notifications require Redis to be configured");
    return;
  }

  // Create a queue. Only home servers will set up the default handler for it (which is what
  // creates a worker to handle jobs in the queue). Others will only add jobs to it.
  const queue = jobs.queue(docEmailsQueue);
  const batchedJobs = new BatchedJobs(jobs, queue, 'email', Deps.schedulesByType);
  return new DocNotificationManager(gristServer, batchedJobs);
}

// Set up endpoints to get and set notifications configuration.
function addConfigEndpoints(homeDb: HomeDBManager, app: express.Express) {
  app.get('/api/docs/:docId/notifications-config', expressWrap(async (req, res) => {
    const fullDocPrefs = await homeDb.getDocPrefs(getDocScope(req));
    res.json({
      docDefaults: makeValidNotificationPrefs(fullDocPrefs.docDefaults.notifications),
      currentUser: makeValidNotificationPrefs(fullDocPrefs.currentUser.notifications),
    });
  }));

  app.post('/api/docs/:docId/notifications-config', expressWrap(async (req, res) => {
    const prefs: unknown = req.body;
    try {
      checkFullNotificationPrefs(prefs);
    } catch (err) {
      throw new ApiError(`Invalid config: ${err.message}`, 400);
    }
    const fullDocPrefs: Partial<FullDocPrefs> = {};
    if (prefs.docDefaults) { fullDocPrefs.docDefaults = {notifications: prefs.docDefaults}; }
    if (prefs.currentUser) { fullDocPrefs.currentUser = {notifications: prefs.currentUser}; }
    await homeDb.setDocPrefs(getDocScope(req), fullDocPrefs);
    res.json(null);
  }));
}


export class DocNotificationManager implements IDocNotificationManager {
  private _homeDb: HomeDBManager;
  private _caches: HomeDBCaches;
  private _specialUserIds: Set<number>;

  public constructor(
    private readonly _gristServer: GristServer,
    private readonly _batchedJobs: BatchedJobs,
  ) {
    this._homeDb = _gristServer.getHomeDBManager();
    if (!this._homeDb.caches) {
      throw new Error("DocNotificationManager: requires caches to be enabled in HomeDBManager");
    }
    this._caches = this._homeDb.caches;

    // Get specialUserIds to exclude, but not the support user, who is normally a valid user.
    this._specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    this._specialUserIds.delete(this._homeDb.getSupportUserId());
  }

  public initHomeServer(app: express.Express): void {
    addConfigEndpoints(this._homeDb, app);
    addUnsubscribeEndpoint(this._gristServer, app);

    // DocNotificationHandler is just there to organize a few bits of related code. We don't yet
    // need to hold a reference to it or to close it on exit. FlexServer already stops GristJobs
    // on exit, which takes care of in-progress job handlers.
    new DocNotificationHandler(this._gristServer, this._batchedJobs);
  }

  /**
   * Called when there is a document change that may need to trigger notifications.
   */
  public async notifySubscribers(
    docSession: OptDocSession,
    docId: string,
    accessControl: GranularAccessForBundle,
  ): Promise<void> {
    // Get user. Skip notifications if no real user (e.g. for Calculate, UpdateCurrentTime).
    const authorUser = docSession.fullUser;
    if (!authorUser) { return; }
    const authorUserId = authorUser.id;

    // In the common case of no comments and no docChange opt-in, we'll short-circuit and return.
    const hasComments = accessControl.hasCommentsInBundle();
    const prefs = await this._fetchNotificationPrefs(docId, hasComments);
    if (prefs.length === 0) { return; }

    const promises: Promise<void>[] = [];

    // Queue up notifications for document changes for opted-in users.
    const usersForDocChanges: UserAccessData[] = (prefs
      .filter(p => p.docChanges && p.user.id != authorUserId)
      .map(p => p.user));
    for (const userData of usersForDocChanges) {
      // For each user opted-in to doc changes, check if there are any direct actions visible to them.
      const description = await accessControl.getDirectTablesInBundle(userData);
      if (description !== null) {
        // If so, construct a payload for a notification to deliver. Note that tables is only null
        // when there are no changes to notify about. If it's an empty array, then there are
        // changes, just no user tables to report.
        promises.push(this._pushDocChange(docId, userData, {authorUserId, ...description}));
      }
    }

    // Queue up notifications for comments. First check if we have any comments.
    // Note that by "mentioned" we mean also anyone who participated in the thread.
    if (hasComments) {
      // Collect the list of users mentioned for each comment. The idea here is to figure out the target
      // audience before applying any access rules to a specific user (which is potentially expensive op).
      const allComments = await accessControl.getCommentsInBundle();
      // This contains all users who should be notified by default if they didn't change their comments
      // preference (which by default is 'relevant').
      const mentionedUserRefs = new Set<string>(allComments.flatMap(c => c.audience));

      // Now for every user decide what comments they are interested in.
      // 1. before applying access control, check user preference to see if there are any interesting comments at all.
      // 2. if user is interested in some of the comments we have, apply access control to filter out comments
      //    that are not visible to them.
      // 3. if there are any comments left, construct the payload and queue them up for delivery.
      for (const {user, comments: commentsPref} of prefs) {
        // Skip current user who is making a change.
        if (user.id === authorUserId) { continue; }
        // Skip users who've opted out.
        if (commentsPref === 'none') { continue; }
        // Skip users who are not mentioned in any comment or who didn't write any comments themselves and
        // are not interested in all comments (The default value is only relevant comments).
        if (user.ref && !mentionedUserRefs.has(user.ref) && commentsPref !== 'all') { continue; }
        // Get comments visible to this user that were added in this bundle.
        const comments = await accessControl.getCommentsInBundle(user);
        // If no comments visible to this user, skip.
        if (comments.length === 0) { continue; }
        // Decide which comments this user is interested in.
        const commentsToNotify = commentsPref === 'all' ? comments : comments.filter(
          c => c.audience.includes(user.ref!)
        );
        if (commentsToNotify.length === 0) { continue; }
        // Add authorUserId, hasMention fields and anchorLink to each comment.
        const payload = commentsToNotify.map((c: DocComment): CommentData => {
          const hasMention = c.mentions.includes(user.ref!);
          return {authorUserId, hasMention, text: c.text, anchorLink: c.anchorLink};
        });
        promises.push(this._pushComments(docId, user, payload));
      }
    }

    await Promise.all(promises);
  }

  public testFetchNotificationPrefs(docId: string) { return this._fetchNotificationPrefs(docId, true); }

  // Fetches all users the doc is shared with and their notification preferences.
  // This is cached because it can be slow: this method is only used to populate _prefsCache.
  private async _fetchNotificationPrefs(docId: string, haveComments: boolean): Promise<NotificationPrefsWithUser[]> {
    const allPrefs = await this._caches.getDocPrefs(docId);

    // If no comments and no docChange subscribers (a very common situation), we don't need to
    // know who has access to the doc, since no one needs to be notified.
    if (!haveComments && !hasDocChangeSubscribers([...allPrefs.values()])) { return []; }

    // NOTE! We look up doc-access without regard to the permissions of the caller (since even a
    // change made by an anonymous user needs to notify appropriate subscribers).
    const access = this._homeDb.unwrapQueryResult(await this._caches.getDocAccess(docId));
    const users = access.users.filter(u => !this._specialUserIds.has(u.id));
    const docDefaults = allPrefs.get(null)?.notifications || {};
    return users.map((user, i) => ({
      ...fillNotificationPrefs(docDefaults, allPrefs.get(user.id)?.notifications),
      user,
    }));
  }

  private _pushDocChange(docId: string, user: UserAccessData, data: DocChangeData) {
    const logMeta = getLogMeta(docId, user);
    return this._batchedJobs.add('docChange', makeBatchKey(docId, user.id), logMeta, JSON.stringify(data));
  }

  private _pushComments(docId: string, user: UserAccessData, data: CommentData[]) {
    const logMeta = getLogMeta(docId, user);
    return this._batchedJobs.add('comment', makeBatchKey(docId, user.id), logMeta, JSON.stringify(data));
  }
}


/**
 * Called only by the home servers, and responsible for handling of notification jobs, to turn
 * queued up events into emails.
 */
class DocNotificationHandler {
  private _homeDb: HomeDBManager;
  private _notifier: INotifier;

  constructor(
    private readonly _gristServer: GristServer,
    batchedJobs: BatchedJobs,
  ) {
    this._homeDb = _gristServer.getHomeDBManager();
    this._notifier = _gristServer.getNotifier();

    // Set up job handling. The default handler is what creates the actual worker to handle all
    // types of jobs in this queue. For unhandled jobs, just log a warning.
    batchedJobs.queue.handleDefault(async (job: GristJob) => {
      log.warn("DocNotificationHandler: UNHANDLED JOB", job);
    });
    batchedJobs.setHandler(this._deliverDocEmail.bind(this));
  }

  private async _deliverDocEmail(jobType: string, batchKey: string, batchedData: string[]) {
    // We don't do special error handling here: if we find an invalid payload, this should lead to
    // an exception (e.g. from JSON.parse), which would mean the job failed. BatchedJobs watches
    // for failures and logs them as warnings.
    const payloads = batchedData.map(d => JSON.parse(d));
    switch (jobType) {
      case 'docChange': return this._sendDocChanges(batchKey, payloads as DocChangeData[]);
      case 'comment': return this._sendComments(batchKey, flatten(payloads as CommentData[][]));
    }
  }

  private async _getCommonInfo(
    batchKey: string,
    notification: DocNotificationEvent
  ): Promise<DocNotificationsCommonTemplateData> {
    const {docId, userId} = parseBatchKey(batchKey);
    const doc = await this._homeDb.getRawDocById(docId);
    const docUrl = await this._gristServer.getResourceUrl(doc);
    const homeUrl = this._gristServer.getGristConfig().homeUrl;
    if (!homeUrl) {
      throw new Error("DocNotificationHandler: cannot deliver notifications: homeUrl is not set");
    }
    const user = await this._homeDb.getUserAndEnsureUnsubscribeKey(userId);
    if (!user) {
      throw new Error(`DocNotificationHandler: user ${userId} not found`);
    }
    const unsubscribeUrl: string = createUnsubscribeUrl({homeUrl, doc, user, notification, mode: 'normal'});
    const unsubscribeFullyUrl: string = createUnsubscribeUrl({homeUrl, doc, user, notification, mode: 'full'});
    return {docName: doc.name, docUrl, unsubscribeUrl, unsubscribeFullyUrl};
  }

  private async _sendDocChanges(batchKey: string, docChanges: DocChangeData[]) {
    // Maps author's userId to list of DocActionsDescriptions they authored.
    const authors = new Map<number, DocActionsDescription[]>();
    for (const c of docChanges) {
      setDefault(authors, c.authorUserId, []).push(c);
    }
    const authorsById = await this._getUserInfoById([...authors.keys()]);
    const template: DocChangesTemplateData = {
      ...(await this._getCommonInfo(batchKey, 'docChanges')),
      senderAuthorName: getSenderAuthorName(authorsById),
      authors: Array.from(authors, ([authorUserId, descriptions]) => {
        // Combine userTableNames from all descriptions using a Set for uniqueness.
        const tables: string[] = [...new Set(descriptions.flatMap(d => d.userTableNames))];
        const categories = sortDocActionCategories(new Set(descriptions.flatMap(d => d.categories)));

        return {
          user: authorsById.get(authorUserId)!,
          tables,
          categories,
          // Need this for saying "Bob made changes to T1, T2, and 3 other tables." (in case of 5
          // tables, for example.)
          numTablesMinus2: tables.length - 2,
        };
      }),
    };
    const {userId} = parseBatchKey(batchKey);
    await this._notifier.docNotification('docChanges', userId, template);
  }

  private async _sendComments(batchKey: string, comments: CommentData[]) {
    const authorUserIds = new Set<number>(comments.map(c => c.authorUserId));
    const authorsById = await this._getUserInfoById([...authorUserIds]);
    const template: CommentsTemplateData = {
      ...(await this._getCommonInfo(batchKey, 'comments')),
      senderAuthorName: getSenderAuthorName(authorsById),
      authorNames: Array.from(authorUserIds, r => authorsById.get(r)?.name || 'Unknown'),
      // Need this for saying "Comments from Alice, Bob, and 2 others" (if there are 4 authors).
      numAuthorsMinus2: authorUserIds.size - 2,
      hasMentions: comments.some(c => c.hasMention),
      comments: comments.map(c => ({
        hasMention: c.hasMention,
        author: authorsById.get(c.authorUserId)!,
        text: c.text,
        anchorLink: c.anchorLink,
      })),
    };
    const {userId} = parseBatchKey(batchKey);
    await this._notifier.docNotification('comments', userId, template);
  }

  private async _getUserInfoById(userIds: number[]): Promise<Map<number, UserInfo>> {
    const users = await this._homeDb.usersManager().getUsersByIds(userIds, {withLogins: true});
    return new Map(users.map(u => [u.id, getUserInfo(this._homeDb.makeFullUser(u))]));
  }
}


function makeBatchKey(docId: string, userId: number) {
  return `${docId}:${userId}`;
}

function parseBatchKey(batchKey: string): {docId: string, userId: number} {
  const [docId, userId] = batchKey.split(':');
  return {docId, userId: Number(userId)};
}

function getUserInfo(user: FullUser): UserInfo {
  return pick(user, 'name', 'email');
}

function hasDocChangeSubscribers(prefs: DocPrefs[]): boolean {
  return prefs.some(p => (p.notifications as NotificationPrefs).docChanges);
}

// Extracts the name of the author when there is a single one; for NotifierTools to include into "From" address.
function getSenderAuthorName(authorsById: Map<unknown, UserInfo>): string|null {
  return (authorsById.size === 1) ? [...authorsById.values()][0].name : null;
}

function getLogMeta(docId: string, user: UserAccessData) {
  return {
    userId: user.id,
    email: user.email,
    docId,
  };
}

export interface DocNotificationsCommonTemplateData {
  docName: string;
  docUrl: string;
  unsubscribeUrl: string;
  unsubscribeFullyUrl: string;
}

interface DocChangeData {
  authorUserId: number;
  userTableNames: string[];
  categories: DocActionCategory[];
}

interface DocChangesTemplateData extends DocNotificationTemplateBase, DocNotificationsCommonTemplateData {
  authors: Array<{
    user: UserInfo;
    tables: string[];
    categories?: string[];
    numTablesMinus2: number;
  }>;
}

interface CommentData {
  /**
   * Id of the user who authored the comment.
   */
  authorUserId: number;
  /**
   * True if the comment mentions the recipient user in the text.
   */
  hasMention: boolean;
  /**
   * Text of the comment.
   */
  text: string;
  /**
   * Anchor link to the comment in the document.
   */
  anchorLink: string;
}

interface CommentsTemplateData extends DocNotificationTemplateBase, DocNotificationsCommonTemplateData {
  /**
   * Name of the authors of the comments.
   */
  authorNames: string[];
  /**
   * Number of authors minus 2 (as we can't do math in templates).
   */
  numAuthorsMinus2: number;
  /**
   * Recipient preference for comments. True if user just wants to be notified about mentions
   * otherwise false.
   */
  hasMentions: boolean;
  comments: Array<{
    hasMention: boolean;
    author: UserInfo;
    text: string;
    anchorLink: string;
  }>;
}

interface UserInfo {
  name: string;
  email: string;
}
