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
import { FullDocPrefs } from 'app/common/Prefs';
import { FullUser, UserAccessData } from 'app/common/UserAPI';
import { getSetMapValue } from 'app/common/gutil';
import { fillNotificationPrefs } from 'app/common/NotificationsConfigAPI';
import { NotificationPrefs, NotificationPrefsBundle } from 'app/common/NotificationPrefs';
import { DocPrefs } from 'app/common/Prefs';
import NotificationPrefsTI from 'app/common/NotificationPrefs-ti';
import { Document } from 'app/gen-server/entity/Document';
import { DocScope, HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { BatchedJobs, Schedule } from 'app/server/lib/BatchedJobs';
import { OptDocSession } from 'app/server/lib/DocSession';
import { DocComment, extractUserRefsFromComment } from 'app/common/DocComments';
import { IDocNotificationManager } from 'app/server/lib/IDocNotificationManager';
import { INotifier } from 'app/server/lib/INotifier';
import { expressWrap } from 'app/server/lib/expressWrap';
import { docEmailsQueue, GristBullMQJobs, GristJob } from 'app/server/lib/GristJobs';
import { GristServer } from 'app/server/lib/GristServer';
import * as log from 'app/server/lib/log';
import { getDocScope } from 'app/server/lib/requestUtils';
import express from 'express';
import { createCheckers } from "ts-interface-checker";
import flatten from 'lodash/flatten';
import pick from 'lodash/pick';

import type { GranularAccessForBundle } from 'app/server/lib/GranularAccess';

// Defines the schedule for notifications.
const schedulesByType: {[jobType: string]: Schedule} = {
  docChange: {
    type: 'email-docChange',
    firstDelay: 2 * 60_000,   // 2 minutes
    throttle: 15 * 60_000,    // 15 minutes
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
  private _specialUserIds: Set<number>;

  public constructor(
    private readonly _gristServer: GristServer,
    private readonly _batchedJobs: BatchedJobs,
  ) {
    this._homeDb = _gristServer.getHomeDBManager();

    // Get specialUserIds to exclude, but not the support user, who is normally a valid user.
    this._specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    this._specialUserIds.delete(this._homeDb.getSupportUserId());
  }

  public initHomeServer(app: express.Express): void {
    addConfigEndpoints(this._homeDb, app);
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

    const allComments = await accessControl.getCommentsInBundle();

    // In the common case of no comments and no docChange opt-in, we'll short-circuit and return.
    const prefs = await this._fetchNotificationPrefs(docId, allComments.length > 0);
    if (prefs.length === 0) { return; }

    const promises: Promise<void>[] = [];

    // Queue up notifications for document changes for opted-in users.
    const usersForDocChanges: UserAccessData[] = (prefs
      .filter(p => p.docChanges && p.user.id != authorUserId)
      .map(p => p.user));
    for (const userData of usersForDocChanges) {
      // For each user opted-in to doc changes, check if there are any direct actions visible to them.
      const tables: string[]|null = await accessControl.getDirectTablesInBundle(userData);
      if (tables !== null) {
        // If so, construct a payload for a notification to deliver. Note that tables is only null
        // when there are no changes to notify about. If it's an empty array, then there are
        // changes, just no user tables to report.
        promises.push(this._pushDocChange(docId, userData.id, {authorUserId, tables}));
      }
    }

    // Queue up notifications for comments. First check if we have any comments.
    // Note that by "mentioned" we mean also anyone who participated in the thread.
    if (allComments.length > 0) {
      // Collect the list of users mentioned for each comment.
      const userRefsByComment = new Map<number, string[]>(allComments.map(c => [c.id, extractUserRefsFromComment(c)]));

      // Collect full set of users mentioned in any comment in the bundle.
      const mentionedUserRefs = new Set<string>();
      for (const userRefs of userRefsByComment.values()) {
        for (const userRef of userRefs) {
          mentionedUserRefs.add(userRef);
        }
      }

      // - For comments, we care about users who opted in AND those mentioned in comments.
      //   1. extract all mentions anywhere among docActions, and list of comments.
      //      if no comments, skip this.
      //   2. combine users opted in to all, and users opted in to mentions who are mentioned
      //   3. for all those, construct an "authorized docSession" for each, filter just comment
      //      actions using granularAccess.
      //      - Filter comments that include mention of that user.
      //      - If any comments left, construct payload for that user
      for (const {user, comments: commentsPref} of prefs) {
        // Skip users who've opted out.
        if (commentsPref === 'none') { continue; }
        // Skip users who only need replies & mentions but aren't mentioned at all.
        if (commentsPref !== 'all' && !mentionedUserRefs.has(user.ref!)) { continue; }
        // Figure out which comments this person is allowed to see.
        const comments = await accessControl.getCommentsInBundle(user);
        if (comments.length === 0) { continue; }
        // Add authorUserId and hasMention fields.
        let payload = comments.map((c: DocComment): CommentData => {
          const hasMention = Boolean(userRefsByComment.get(c.id)?.includes(user.ref!));
          return {authorUserId, hasMention, text: c.text, anchorLink: c.anchorLink};
        });
        // For users who only need replies & mentions, omit notifications irrelavant to them.
        if (commentsPref !== 'all') {
          payload = payload.filter(c => c.hasMention);
        }
        promises.push(this._pushComments(docId, user.id, payload));
      }
    }

    await Promise.all(promises);
  }

  public testFetchNotificationPrefs(docId: string) { return this._fetchNotificationPrefs(docId, true); }

  // Fetches all users the doc is shared with and their notification preferences.
  // TODO This is actually too slow to do for each action because getDocAccess() is a slow call.
  // It needs caching to allow having this info ready when we need it.
  // XXX To be clear, this is NOT acceptable to turn on on prod, it'll overload the database.
  private async _fetchNotificationPrefs(docId: string, haveComments: boolean): Promise<NotificationPrefsWithUser[]> {
    const allPrefs = await this._homeDb.getDocPrefsForUsers(docId, 'any');

    // If no comments and no docChange subscribers (a very common situation), we don't need to
    // know who has access to the doc, since no one needs to be notified.
    if (!haveComments && !hasDocChangeSubscribers([...allPrefs.values()])) { return []; }

    // NOTE! We use the special "previewer" to get a list of who the doc is shared with regardless of
    // permissions of the caller (since even a change made by an anonymous user needs to notify
    // appropriate subscribers).
    const bypassScope: DocScope = {userId: this._homeDb.getPreviewerUserId(), urlId: docId};
    const access = this._homeDb.unwrapQueryResult(
      await this._homeDb.getDocAccess(bypassScope, {flatten: true, excludeUsersWithoutAccess: true}));
    const users = access.users.filter(u => !this._specialUserIds.has(u.id));
    const docDefaults = allPrefs.get(null)?.notifications || {};
    return users.map((user, i) => ({
      ...fillNotificationPrefs(docDefaults, allPrefs.get(user.id)?.notifications),
      user,
    }));
  }

  private _pushDocChange(docId: string, userId: number, data: DocChangeData) {
    return this._batchedJobs.add('docChange', makeBatchKey(docId, userId), JSON.stringify(data));
  }

  private _pushComments(docId: string, userId: number, data: CommentData[]) {
    return this._batchedJobs.add('comment', makeBatchKey(docId, userId), JSON.stringify(data));
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

  private async _getCommonInfo(batchKey: string) {
    const {docId, userId} = parseBatchKey(batchKey);
    const doc = await this._homeDb.getRawDocById(docId);
    const docUrl = await this._gristServer.getResourceUrl(doc);
    const unsubscribeUrl = this._createUnsubscribeUrl(doc, userId, 'normal');
    const unsubscribeFullyUrl = this._createUnsubscribeUrl(doc, userId, 'full');
    return { docName: doc.name, docUrl, unsubscribeUrl, unsubscribeFullyUrl };
  }

  private async _sendDocChanges(batchKey: string, docChanges: DocChangeData[]) {
    const authors = new Map<number, Set<string>>();
    for (const c of docChanges) {
      const tables = getSetMapValue(authors, c.authorUserId, () => new Set());
      for (const t of c.tables) {
        tables.add(t);
      }
    }
    const authorsById = await this._getUserInfoById([...authors.keys()]);
    const template: DocChangesTemplateData = {
      ...(await this._getCommonInfo(batchKey)),
      authors: Array.from(authors, ([authorUserId, tables]) => ({
        user: authorsById.get(authorUserId)!,
        tables: Array.from(tables),
        // Need this for saying "Bob made changes to T1, T2, and 3 other tables." (in case of 5
        // tables, for example.)
        numTablesMinus2: tables.size - 2,
      })),
    };
    const {userId} = parseBatchKey(batchKey);
    await this._notifier.docNotification(userId, template);
  }

  private async _sendComments(batchKey: string, comments: CommentData[]) {
    const authorUserIds = new Set<number>(comments.map(c => c.authorUserId));
    const authorsById = await this._getUserInfoById([...authorUserIds]);
    const template: CommentsTemplateData = {
      ...(await this._getCommonInfo(batchKey)),
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
    await this._notifier.docNotification(userId, template);
  }

  private async _getUserInfoById(userIds: number[]): Promise<Map<number, UserInfo>> {
    const users = await this._homeDb.usersManager().getUsersByIds(userIds, {withLogins: true});
    return new Map(users.map(u => [u.id, getUserInfo(this._homeDb.makeFullUser(u))]));
  }

  /**
   * TODO: Not yet implemented.
   * Creates a URL that allows unsubscribing from notifications in this document for the given
   * user. In 'normal' mode, resets notifications preferences to defaults ("comment replies &
   * mentions only"). In 'full' mode, sets notifications preferences to opt out even of those.
   */
  private _createUnsubscribeUrl(doc: Document, userId: number, mode: 'normal'|'full') {
    // TODO The idea is to set a Permit, with a long-ish TTL (perhaps
    // 24 hours or a week), and add a special endpoint that would check this permit. It may be simpler to
    // bypass the actual Permit system and use Redis directly, in which case we only need one key
    // per (doc,user), updating TTL to keep a valid window.
    return '';
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

interface DocChangeData {
  authorUserId: number;
  tables: string[];
}

interface DocChangesTemplateData {
  docName: string;
  docUrl: string;
  unsubscribeUrl: string;
  authors: Array<{
    user: UserInfo;
    tables: string[];
    numTablesMinus2: number;
  }>;
}

interface CommentData {
  authorUserId: number;
  hasMention: boolean;
  text: string;
  anchorLink: string;
}

interface CommentsTemplateData {
  docName: string;
  docUrl: string;
  authorNames: string[];
  numAuthorsMinus2: number;
  unsubscribeUrl: string;
  unsubscribeFullyUrl: string;
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
