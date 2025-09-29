/**
 * This implements the unsubscribe functionality for document notifications.
 *
 * When notification emails are sent, they include unsubscribe links that allow users to opt out
 * of specific types of notifications without needing to log in. The links contain signed tokens
 * that encode the docId, user, and notification type and mode (for comments). Token can expire
 * after a set period (60 days).
 *
 * The unsubscribe link for comments supports two modes:
 * - 'normal': sets preference to 'relevant' (only mentions and participated threads, which is default)
 * - 'full': sets preference to 'none' (no comment notifications at all)
 *
 * For document changes, unsubscribe simply sets the preference to false (which is default, but we
 * store it nevertheless to remember the user's choice).
 *
 * Tokens are signed using the user's unsubscribeKey (stored in the User entity) and expire after
 * 60 days. If the token has expired, we still will show the unsubscribe page, but will inform
 * the user about the error and advice them to change the preferences after logging in.
 *
 * The signing mechanism is implemented using HMAC. It produces links that are readable by the user
 * and relatively short. The alternative was to use JWT, but that would produce much longer and
 * non-human readable tokens.
 */
import {ApiError} from 'app/common/ApiError';
import {NotificationPrefs} from 'app/common/NotificationPrefs';
import {Document} from 'app/gen-server/entity/Document';
import {User} from 'app/gen-server/entity/User';
import {DocScope} from 'app/gen-server/lib/homedb/HomeDBManager';
import {DocNotificationEvent, DocNotificationEvents} from 'app/gen-server/lib/NotifierTypes';
import {expressWrap} from 'app/server/lib/expressWrap';
import {GristServer} from 'app/server/lib/GristServer';
import log from 'app/server/lib/log';
import {optStringParam, stringParam} from 'app/server/lib/requestUtils';
import crypto from 'crypto';
import express from 'express';
import moment from 'moment-timezone';


// Name of the query parameter carrying the unsubscribe token.
export const UNSUBSCRIBE_TOKEN_PARAMETER = 'token';

// Unsubscribe links expire after this many days.
const EXPIRATION_DAYS = 60;

// Sets up the /unsubscribe endpoint used in document notification emails.
export function addUnsubscribeEndpoint(server: GristServer, app: express.Express) {
  // GET /notifications-unsubscribe?token=xxxx
  // Unsubscribe from notifications for a document, using a token that identifies the
  // (doc, user) pair alongside the type of notification to unsubscribe from.
  app.get('/notifications-unsubscribe', expressWrap(async (req, res) => {
    let docUrl = '';
    try {
      // Validate and extract parameters.
      const tokenStr = stringParam(
        req.query[UNSUBSCRIBE_TOKEN_PARAMETER],
        UNSUBSCRIBE_TOKEN_PARAMETER,
        {allowEmpty: false}
      );

      // Parse the token to get userRef and then get's user secret.
      const token = parseUnsubscribeToken(tokenStr);
      const user = await server.getHomeDBManager().getUserByRef(token.userRef);

      // Get the raw document (and check that it exists).
      const doc = await server.getHomeDBManager().getRawDocById(token.docId);
      docUrl = await server.getResourceUrl(doc);

      // Now verify that the token is valid.
      if (!user || !user.unsubscribeKey) {
        throw new ApiError('Invalid unsubscribe link', 400);
      }
      verifyUnsubscribeToken(token, user.unsubscribeKey);

      // Calculate new preferences for unsubscribe.
      const fullDocPrefs = (await server.getHomeDBManager().getDocPrefsForUsers(token.docId, [user.id])).get(user.id);
      const oldNotification = fullDocPrefs?.notifications || {};
      const notifications: NotificationPrefs = {
        ...oldNotification,
        // For doc changes, we just set false to unsubscribe.
        // For comments depending on the mode:
        // - full: means that users don't want to be notified about any comments even if they are mentioned. So
        //   we set 'none'.
        // - normal: means that users don't want to be notified comments that they don't participate in. So we set
        //   'relevant'.
        [token.notification]: token.notification === 'docChanges' ? false
                                                                  : (token.mode === 'full' ? 'none' : 'relevant'),
      };

      // This time use the proper scope of the user we found from the token, to check that they still have access
      // to the document.
      const scope: DocScope = {urlId: token.docId, userId: user.id};
      await server.getHomeDBManager().setDocPrefs(scope, {currentUser: {notifications}});

      await server.sendAppPage(req, res, {
        path: 'error.html', status: 200, config: {
          errPage: 'unsubscribed',
          errDetails: {
            docName: doc.name,
            docUrl,
            notification: token.notification,
            mode: token.mode || '',
            email: user.loginEmail || '',
          },
        }
      });
    } catch (err) {
      log.error('Error processing unsubscribe request', err);
      await server.sendAppPage(req, res, {
        path: 'error.html', status: 200, config: {
          errPage: 'unsubscribed',
          errMessage: (err instanceof Error) ? err.message : 'Unknown error',
          errDetails: {
            docUrl,
          },
        }
      });
      return;
    }
  }));
}

export function createUnsubscribeUrl(options: {
  homeUrl: string,
  doc: Document,
  user: User,
  notification: DocNotificationEvent,
  mode?: 'normal' | 'full'
}) {
  const {homeUrl, doc, user, notification, mode} = options;
  const url = new URL(`${homeUrl}/notifications-unsubscribe`);
  const data: UnsubscribeData = {
    docId: doc.id,
    userRef: user.ref,
    notification,
  };
  if (notification === 'comments' && mode) {
    data.mode = mode;
  }
  url.searchParams.set(UNSUBSCRIBE_TOKEN_PARAMETER, unsubscribeToken(data, user.unsubscribeKey || ''));
  return url.toString();
}

/**
 * Creates a signed, temporary token encoding the unsubscribe data, using the user's unsubscribeKey.
 */
export function unsubscribeToken(data: UnsubscribeData, unsubscribeKey: string, now = Date.now()): string {
  if (!unsubscribeKey) {
    throw new Error('Cannot sign unsubscribe data: user has no unsubscribeKey');
  }
  // Prepare data to sign, including expiration timestamp.
  const expiration = moment.utc(now).add(EXPIRATION_DAYS, 'days').format('YYYYMMDD');
  const toSign = `${data.docId}|${data.userRef}|${data.notification}|${data.mode || ''}|${expiration}`;
  // Create a signature of that text.
  const sig = crypto.createHmac('sha256', unsubscribeKey).update(toSign).digest('base64url');
  return `${toSign}|${sig}`;
}

/**
 * Parses an unsubscribe token, extracting all fields without verifying signature or expiration.
 * @param token The token to parse.
 */
export function parseUnsubscribeToken(token: string): UnsubscribeTokenData {
  const parts = token.split('|');
  if (parts.length !== 6) {
    throw new Error('Invalid unsubscribe token format');
  }
  const [docId, userRef, notification, mode, expirationStr, sig] = parts;
  stringParam(docId, 'docId', {allowEmpty: false});
  optStringParam(mode || undefined, 'mode', {allowed: ['normal', 'full']});
  stringParam(notification, 'notification', {allowed: DocNotificationEvents.values});
  const expiration = stringParam(expirationStr, 'expiration');
  stringParam(sig, 'sig', {allowEmpty: false});
  return {
    docId,
    userRef,
    notification: notification as DocNotificationEvent,
    expiration,
    sig,
    ...(mode ? {mode: mode as any} : {})
  };
}

/**
 * Verifies the signature and expiration of parsed unsubscribe token data.
 * @param data Parsed token data from parseUnsubscribeTokenRaw.
 * @param unsubscribeKey Users unsubscribeKey to verify the signature.
 */
export function verifyUnsubscribeToken(
  data: UnsubscribeTokenData,
  unsubscribeKey: string,
  now = Date.now()
) {
  if (!unsubscribeKey) {
    throw new Error("This unsubscribe link isn't valid any more.");
  }
  const wasSigned = [data.docId, data.userRef, data.notification, data.mode, data.expiration].join('|');
  const expectedSig = crypto.createHmac('sha256', unsubscribeKey).update(wasSigned).digest('base64url');
  if (data.sig !== expectedSig) {
    throw new Error("This unsubscribe link isn't valid.");
  }
  if (moment.utc(now).format('YYYYMMDD') > data.expiration) {
    throw new Error('This unsubscribe link is no longer active.');
  }
}

/**
 * Data encoded in an unsubscribe token.
 */
export interface UnsubscribeData {
  docId: string; // Document id.
  userRef: string; // User ref (not id, since id is not stable across instances).
  notification: DocNotificationEvent; // 'docChanges' or 'comments'
  mode?: 'normal' | 'full'; // Mode only filled for comments
}

export interface UnsubscribeTokenData extends UnsubscribeData {
  expiration: string; // Expiration timestamp as YYYYMMDD
  sig: string;
}
