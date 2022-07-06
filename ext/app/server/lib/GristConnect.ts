/**
 * Endpoint to SSO flow based on Discourse description available at:
 * https://meta.discourse.org/t/discourseconnect-official-single-sign-on-for-discourse-sso/13045
 *
 * Adds one endpoint:
 *  - /connect/login: callback url for external Identity Provider.
 *
 * Expects environment variables:
 *  - GRIST_CONNECT_URL: URL of the Identity Provider endpoint to which user will be redirected upon login.
 *  - GRIST_CONNECT_SECRET: Secret for checking and adding signatures.
 *  - GRIST_CONNECT_ENDPOINT (optional): Overrides endpoint address (defaults to /connect/login).
 *  - GRIST_CONNECT_LOGOUT_URL (optional): Url to which user will be redirected after logging out (defaults
 *                                        to home page).
 *
 *  Additionally relies on those environmental variables:
 *  - COOKIE_MAX_AGE: If set to 'none' makes cookie last only for active session (useful for SSO flow).
 *  - GRIST_FORCE_LOGIN: If set to true, user is required to be logged in (useful for SSO flow).
 */

import {ApiError} from 'app/common/ApiError';
import {UserProfile} from 'app/common/LoginSessionAPI';
import {RequestWithLogin} from 'app/server/lib/Authorizer';
import {forceSessionChange} from 'app/server/lib/BrowserSession';
import {calcSignature} from 'app/server/lib/DiscourseConnect';
import {expressWrap} from 'app/server/lib/expressWrap';
import {GristLoginMiddleware, GristLoginSystem, GristServer} from 'app/server/lib/GristServer';
import log from 'app/server/lib/log';
import {stringParam} from 'app/server/lib/requestUtils';
import type {NextFunction, Request, Response} from 'express';
import {URL, URLSearchParams} from 'url';

// Remote identity provider URL. Setting this will enable this login system.
const GRIST_CONNECT_URL = process.env.GRIST_CONNECT_URL;
// Required secret key for signing requests.
const GRIST_CONNECT_SECRET = process.env.GRIST_CONNECT_SECRET;
// Optional override for callback URL.
const GRIST_CONNECT_ENDPOINT = process.env.GRIST_CONNECT_ENDPOINT || '/connect/login';

// A hook for dependency injection. Allows tests to override these variables on the fly.
export const Deps = {GRIST_CONNECT_URL, GRIST_CONNECT_SECRET};

/**
 * Checks if GristConnect is enabled.
 */
export function isConnectEnabled() {
  return !!Deps.GRIST_CONNECT_URL;
}

function assertConfig() {
  if (!Deps.GRIST_CONNECT_URL || !Deps.GRIST_CONNECT_SECRET) {
    throw new Error('Grist Connect is not configured');
  }
}

/**
 * Removes nonce (permit) from the store.
 */
async function invalidateNonce(server: GristServer, nonce: string) {
  const permitStore = server.getExternalPermitStore();
  await permitStore.removePermit(permitStore.getKeyPrefix() + nonce);
}

/**
 * Returns a new URL with all query parameters signed using GRIST_CONNECT_SECRET. Payload is stored
 * in 'sso' query parameter, signature is stored in 'sig' query parameter.
 *
 * Example:
 *  const url = new URL("http://example.com?user=1&client2");
 *  const sUrl = signedUrl(url, SECRET);
 *  sUrl; // http://example.com?sso=BASE64_SEARCH_PARAMS&sig=SIGNATURE
 */
export function signedUrl(url: URL, secret: string) {
  // Serialize and encode whole query string.
  const sso = Buffer.from(url.searchParams.toString()).toString('base64');
  // Calculate signature.
  const sig = calcSignature(sso, secret);
  // Create new signed URL.
  const signed = new URL(url.href);
  signed.search = new URLSearchParams({sso, sig}).toString();
  return signed;
}

/**
 * Verifies and reads signed Request (it is reversed signedUrl) method.
 */
function verifiedRequest(req: Request) {
  assertConfig();
  const sso = stringParam(req.query.sso, 'sso');
  const sig = stringParam(req.query.sig, 'sig');
  if (calcSignature(sso, Deps.GRIST_CONNECT_SECRET!) !== sig) {
    throw new ApiError('Invalid signature for Grist Connect request', 403);
  }
  const params = new URLSearchParams(Buffer.from(sso, 'base64').toString('utf8'));
  return params;
}

/**
 * Creates signed Identity Provider request URL.
 */
function createIPProviderUrl(nonce: string, endpointUrl: string): URL {
  assertConfig();
  const redirect_url = new URL(Deps.GRIST_CONNECT_URL!);
  redirect_url.searchParams.set('nonce', nonce);
  // We will pass return_url for the endpoint to use, but since this endpoint is static, the IP can
  // be configured to ignore this parameter and use static pre-configured URL address.
  redirect_url.searchParams.set('return_url', endpointUrl);
  return signedUrl(redirect_url, Deps.GRIST_CONNECT_SECRET!);
}

/**
 * Creates nonce (one time token) for the request send to Identity Provider. Grist uses
 * a permit id for this purpose that will be invalidated after 10m or right after response. It means
 * user has about 10 minutes to sign in using remote provider. Permit holds information about the
 * current session id and an URL which user requested (that triggered this login process).
 */
async function createNonce(server: GristServer, req: Request, redirectUrl: string) {
  const permitStore = server.getExternalPermitStore();
  const sessionId = server.getSessions().getSessionIdFromRequest(req);
  if (!sessionId) {
    throw new Error('no session available');
  }
  const permit = {
    url: redirectUrl,
    sessionId,
  };
  const nonce = await permitStore.setPermit(permit, 10 * 60 * 1000 /* 10m */);
  return nonce.replace(permitStore.getKeyPrefix(), '');
}

/**
 * Login endpoint for GristConnect. User will be redirected here after successful login attempt
 * in the remote Identity Provider site.
 */
async function connectLoginEndpoint(gristServer: GristServer, req: Request, res: Response, next: NextFunction) {
  assertConfig();

  const params = verifiedRequest(req);
  const nonce = params.get('nonce');
  if (!nonce) {
    throw new Error('Missing nonce parameter');
  }

  const permitStore = gristServer.getExternalPermitStore();
  const permit = await permitStore.getPermit(permitStore.getKeyPrefix() + nonce);
  if (!permit) {
    throw new Error('Invalid or expired request');
  }
  // Remove permit right away - to prevent repeating same request many times.
  await invalidateNonce(gristServer, nonce);

  if (!params.get('email')) {
    return next(new Error('No email in response'));
  }
  if (!params.get('name')) {
    return next(new Error('No name in response'));
  }
  if (!params.get('external_id')) {
    return next(new Error('No external_id in response'));
  }
  const connectId = params.get("external_id");
  // Picture is optional parameter (can also be send as avatar_url to make it compatible with Discourse).
  const picture = params.get('picture') ?? params.get('avatar_url') ?? undefined;
  const profile: UserProfile = {
    email: params.get('email')!,
    name: params.get('name')!,
    ...(picture ? {picture} : {}),
    loginMethod: 'External',
    connectId
  };

  // Ensure that this user does exist. We can't rely on getUserByLogin since email might have changed.
  await gristServer.getHomeDBManager().ensureExternalUser(profile);

  // Update session information. Now profile should be stored in database.
  const scopedSession = gristServer.getSessions().getOrCreateSessionFromRequest(req, {sessionId: permit.sessionId});
  await scopedSession.operateOnScopedSession(req, async user =>
    Object.assign(user, {
      profile,
    })
  );
  forceSessionChange((req as RequestWithLogin).session);

  // Redirect to original URL or home URL. Make extra sure that we are not redirecting to connect endpoint.
  // This can happen on the error page (since the address isn't changed).
  // TODO: check if other login systems have the same issue.
  let redirectUrl = gristServer.getHomeUrl(req);
  if (permit.url && !new URL(permit.url).pathname.startsWith(GRIST_CONNECT_ENDPOINT)) {
    redirectUrl = permit.url;
  }
  log.info(`GristConnect: Logged in as ${params.get('email')} successful, redirecting to ${redirectUrl}`, profile);
  return res.redirect(redirectUrl);
}

export async function getConnectLoginSystem(): Promise<GristLoginSystem | null> {
  if (!isConnectEnabled()) {
    return null;
  }
  return {
    async getMiddleware(gristServer: GristServer): Promise<GristLoginMiddleware> {
      async function getLoginRedirectUrl(req: Request, target: URL): Promise<string> {
        const nonce = await createNonce(gristServer, req, target.href);
        const ipUrl = createIPProviderUrl(
          nonce,
          // We will pass our endpoint, though IPProvider might be configured with a static address.
          gristServer.getHomeUrl(req, GRIST_CONNECT_ENDPOINT)
        );
        return ipUrl.href;
      }
      return {
        getLoginRedirectUrl,
        getSignUpRedirectUrl: getLoginRedirectUrl,
        async getLogoutRedirectUrl(req: Request, url: URL) {
          if (process.env.GRIST_CONNECT_LOGOUT_URL) {
            return process.env.GRIST_CONNECT_LOGOUT_URL;
          }
          if (process.env.GRIST_FORCE_LOGIN === 'true') {
            return gristServer.getHomeUrl(req);
          }
          return url.href;
        },
        async addEndpoints(app) {
          app.get(GRIST_CONNECT_ENDPOINT, expressWrap(connectLoginEndpoint.bind(null, gristServer)));
          return 'connect';
        },
      };
    },
    async deleteUser() {
      // nothing to do
    },
  };
}
