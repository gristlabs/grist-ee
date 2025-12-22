/**
 * Endpoint to SSO flow based on Discourse description available at:
 * https://meta.discourse.org/t/discourseconnect-official-single-sign-on-for-discourse-sso/13045
 *
 * Adds one endpoint:
 *  - /connect/login: callback url for external Identity Provider.
 *
 * To read more about Grist Connect SSO flow and configuration through environmental variables, in a single server
 * setup, please visit:
 * https://support.getgrist.com/install/grist-connect
 *
 * Configuration:
 *  - url: URL of the Identity Provider endpoint to which user will be redirected upon login.
 *  - secret: Secret for checking and adding signatures.
 *  - endpoint (optional): Overrides endpoint address (defaults to /connect/login).
 *  - logoutUrl (optional): Url to which user will be redirected after logging out (defaults
 *                          to home page).
 *  - forceLogin (optional): If set to true, user is required to be logged in after logout (useful for SSO flow).
 *
 *  Additionally relies on those environmental variables:
 *  - COOKIE_MAX_AGE: If set to 'none' makes cookie last only for active session (useful for SSO flow).
 */

import {ApiError} from 'app/common/ApiError';
import {GRIST_CONNECT_PROVIDER_KEY} from 'app/common/loginProviders';
import {UserProfile} from 'app/common/LoginSessionAPI';
import {AppSettings} from 'app/server/lib/AppSettings';
import {RequestWithLogin} from 'app/server/lib/Authorizer';
import {forceSessionChange} from 'app/server/lib/BrowserSession';
import {calcSignature} from 'app/server/lib/DiscourseConnect';
import {expressWrap} from 'app/server/lib/expressWrap';
import {GristLoginMiddleware, GristLoginSystem, GristServer} from 'app/server/lib/GristServer';
import {createLoginProviderFactory, NotConfiguredError} from 'app/server/lib/loginSystemHelpers';
import log from 'app/server/lib/log';
import {stringParam} from 'app/server/lib/requestUtils';
import type {NextFunction, Request, Response} from 'express';
import {URL, URLSearchParams} from 'url';

/**
 * Interface for GristConnect configuration.
 */
export interface GristConnectConfig {
  /** URL of the Identity Provider endpoint */
  readonly url: string;
  /** Secret for checking and adding signatures */
  readonly secret: string;
  /** Override for callback endpoint address (defaults to /connect/login) */
  readonly endpoint: string;
  /** URL to redirect to after logout (defaults to home page) */
  readonly logoutUrl: string;
  /** If true, force login after logout (useful for SSO flow) */
  readonly forceLogin: boolean;
}

/**
 * Read GristConnect configuration from application settings.
 */
export function readGristConnectConfigFromSettings(settings: AppSettings): GristConnectConfig {
  const forceLogin = settings.section('login').flag('forced').readBool({
    envVar: 'GRIST_FORCE_LOGIN',
    defaultValue: false,
  })!;

  const section = settings.section('login').section('system').section(GRIST_CONNECT_PROVIDER_KEY);

  const url = section.flag('url').readString({
    envVar: 'GRIST_CONNECT_URL',
  });

  if (!url) {
    throw new NotConfiguredError('GristConnect is not configured: missing url');
  }

  const secret = section.flag('secret').requireString({
    envVar: 'GRIST_CONNECT_SECRET',
    censor: true,
  });

  const endpoint = section.flag('endpoint').readString({
    envVar: 'GRIST_CONNECT_ENDPOINT',
    defaultValue: '/connect/login',
  })!;

  const logoutUrl = section.flag('logoutUrl').readString({
    envVar: 'GRIST_CONNECT_LOGOUT_URL',
    defaultValue: '',
  })!;

  return {url, secret, endpoint, logoutUrl, forceLogin};
}

/**
 * Validates GristConnect configuration.
 */
function assertConfig(config: GristConnectConfig) {
  if (!config.url || !config.secret) {
    throw new Error('Grist Connect is not configured: url and secret are required');
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
function verifiedRequest(req: Request, config: GristConnectConfig) {
  assertConfig(config);
  const sso = stringParam(req.query.sso, 'sso');
  const sig = stringParam(req.query.sig, 'sig');
  if (calcSignature(sso, config.secret) !== sig) {
    throw new ApiError('Invalid signature for Grist Connect request', 403);
  }
  const params = new URLSearchParams(Buffer.from(sso, 'base64').toString('utf8'));
  return params;
}

/**
 * Creates signed Identity Provider request URL.
 */
function createIPProviderUrl(nonce: string, endpointUrl: string, config: GristConnectConfig): URL {
  assertConfig(config);
  const redirect_url = new URL(config.url);
  redirect_url.searchParams.set('nonce', nonce);
  // We will pass return_url for the endpoint to use, but since this endpoint is static, the IP can
  // be configured to ignore this parameter and use static pre-configured URL address.
  redirect_url.searchParams.set('return_url', endpointUrl);
  return signedUrl(redirect_url, config.secret);
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
async function connectLoginEndpoint(
  gristServer: GristServer,
  config: GristConnectConfig,
  req: Request,
  res: Response,
  next: NextFunction
) {
  assertConfig(config);

  const params = verifiedRequest(req, config);
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

  const endpoint = config.endpoint;
  // Redirect to original URL or home URL. Make extra sure that we are not redirecting to connect endpoint.
  // This can happen on the error page (since the address isn't changed).
  // TODO: check if other login systems have the same issue.
  let redirectUrl = gristServer.getHomeUrl(req);
  if (permit.url && !new URL(permit.url).pathname.startsWith(endpoint)) {
    redirectUrl = permit.url;
  }
  log.info(`GristConnect: Logged in as ${params.get('email')} successful, redirecting to ${redirectUrl}`, profile);
  return res.redirect(redirectUrl);
}

/**
 * Return GristConnect login system if enabled, or undefined otherwise.
 */
async function getLoginSystem(settings: AppSettings): Promise<GristLoginSystem> {
  const config = readGristConnectConfigFromSettings(settings);

  return {
    async getMiddleware(gristServer: GristServer): Promise<GristLoginMiddleware> {
      async function getLoginRedirectUrl(req: Request, target: URL): Promise<string> {
        const nonce = await createNonce(gristServer, req, target.href);
        const ipUrl = createIPProviderUrl(
          nonce,
          // We will pass our endpoint, though IPProvider might be configured with a static address.
          gristServer.getHomeUrl(req, config.endpoint),
          config
        );
        return ipUrl.href;
      }
      return {
        getLoginRedirectUrl,
        getSignUpRedirectUrl: getLoginRedirectUrl,
        async getLogoutRedirectUrl(req: Request, url: URL) {
          if (config.logoutUrl) {
            return config.logoutUrl;
          }
          if (config.forceLogin) {
            return gristServer.getHomeUrl(req);
          }
          return url.href;
        },
        async addEndpoints(app) {
          app.get(config.endpoint, expressWrap(connectLoginEndpoint.bind(null, gristServer, config)));
          return 'connect';
        },
      };
    },
    async deleteUser() {
      // nothing to do
    },
  };
}

export const getConnectLoginSystem = createLoginProviderFactory(
  GRIST_CONNECT_PROVIDER_KEY,
  getLoginSystem
);
