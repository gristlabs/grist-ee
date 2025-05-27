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
 */
import { ApiError } from 'app/common/ApiError';
import { FullDocPrefs } from 'app/common/Prefs';
import { UserAccessData } from 'app/common/UserAPI';
import { fillNotificationPrefs } from 'app/common/NotificationsConfigAPI';
import { NotificationPrefs, NotificationPrefsBundle } from 'app/common/NotificationPrefs';
import NotificationPrefsTI from 'app/common/NotificationPrefs-ti';
import { DocScope, HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { RequestWithLogin } from 'app/server/lib/Authorizer';
import { expressWrap } from 'app/server/lib/expressWrap';
import { getDocScope } from 'app/server/lib/requestUtils';
import express from 'express';
import {createCheckers} from "ts-interface-checker";

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

export interface NotificationPrefsWithUser {
  user: UserAccessData;
  notifications: NotificationPrefs;
}

export class NotificationsConfig {
  public static addEndpoints(dbManager: HomeDBManager, app: express.Express) {
    const impl = new NotificationsConfig(dbManager);

    // Helper for the parts shared between endpoints.
    function handle(handler: (req: RequestWithLogin) => unknown|Promise<unknown>) {
      return expressWrap(async (req: express.Request, res: express.Response) => {
        res.json((await handler(req as RequestWithLogin)) || null);
      });
    }
    app.get('/api/docs/:docId/notifications-config', handle((req) => {
      return impl.getNotificationsConfig(getDocScope(req));
    }));
    app.post('/api/docs/:docId/notifications-config', handle((req) => {
      const prefs: unknown = req.body;
      try {
        checkFullNotificationPrefs(prefs);
      } catch (err) {
        throw new ApiError(`Invalid config: ${err.message}`, 400);
      }
      return impl.setNotificationsConfig(getDocScope(req), prefs);
    }));
    return impl;
  }

  private _specialUserIds: Set<number>;

  public constructor(
    private readonly _homeDb: HomeDBManager,
  ) {
    this._specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    // Don't exclude the support user; that's normally an actual valid user.
    this._specialUserIds.delete(this._homeDb.getSupportUserId());
  }

  public async getNotificationsConfig(scope: DocScope): Promise<NotificationPrefsBundle> {
    const fullDocPrefs = await this._homeDb.getDocPrefs(scope);
    return {
      docDefaults: makeValidNotificationPrefs(fullDocPrefs.docDefaults.notifications),
      currentUser: makeValidNotificationPrefs(fullDocPrefs.currentUser.notifications),
    };
  }
  public async setNotificationsConfig(scope: DocScope, config: Partial<NotificationPrefsBundle>): Promise<void> {
    const fullDocPrefs: Partial<FullDocPrefs> = {};
    if (config.docDefaults) { fullDocPrefs.docDefaults = {notifications: config.docDefaults}; }
    if (config.currentUser) { fullDocPrefs.currentUser = {notifications: config.currentUser}; }
    return await this._homeDb.setDocPrefs(scope, fullDocPrefs);
  }

  // Fetches all users the doc is shared with and their notification preferences.
  public async listNotificationsConfigs(scope: DocScope): Promise<NotificationPrefsWithUser[]> {
    const access = this._homeDb.unwrapQueryResult(
      await this._homeDb.getDocAccess(scope, {flatten: true, excludeUsersWithoutAccess: true}));
    const users = access.users.filter(u => !this._specialUserIds.has(u.id));
    const userIds = users.map(u => u.id);
    const allPrefs = await this._homeDb.getDocPrefsForUsers(scope.urlId, userIds);
    const docDefaults = allPrefs.get(null)?.notifications || {};
    return users.map((user, i) => ({
      user,
      notifications: fillNotificationPrefs(docDefaults, allPrefs.get(user.id)?.notifications),
    }));
  }
}
