import {ActivationStatus} from 'app/common/ActivationAPI';
import {ApiError} from 'app/common/ApiError';
import {clamp} from 'app/common/gutil';
import {ActivationsManager} from 'app/gen-server/lib/ActivationsManager';
import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {ActivationReader, Deps, KEYS} from 'app/server/lib/ActivationReader';
import {RequestWithLogin} from 'app/server/lib/Authorizer';
import {expressWrap} from 'app/server/lib/expressWrap';
import {GristServer} from 'app/server/lib/GristServer';
import {IBilling} from 'app/server/lib/IBilling';
import {LogMethods} from 'app/server/lib/LogMethods';
import {optIntegerParam, sendOkReply, stringParam} from 'app/server/lib/requestUtils';
import * as express from 'express';


/*

The activation flow, as it is hard to grasp just from the code:
Here is a high level overview of the request processing flow and where
activation is checked and updated.
Remember that we might have concurrent requests at the same time (and
database api is asynchronous), and we might have multiple servers running
at the same time. As a basic synchronization unit we will use database
transactions, and we will retry on deadlocks or ignore them if the
activation row in database was updated by another request or server.

   (Request started)
        |
        |
  1. (middleware for checking the activation status)
        |
        |
  2. (activation endpoint for updating the key)
        |
        |
  X. (redis message received) (somewhere along the line)
        |
        |
      (Request processing)

1. middleware status endpoint:
  - This will validate the key as the endpoint above, and persist the result in the
    database. But it will do it once an hour, caching the result. It will also retry
    until the record in database was actually updated, either by this request, or by
    other request or other server.
    It means, that at the start, all servers during initial requests, will compete
    to update the record in database, but only one will succeed.
    It will also turn the grist on or off, based on the result.
    It also will inform other servers that the key was updated.
2. Activation endpoint:
  - This is called by the user, it will replace the key in the database.
    It will do it in a transaction, and in case of a deadlock, it will retry until
    it succeeds. In that transaction, it will validate the key against the current
    limits, dates and so on, and will persist the key and the result in database.
    It will inform other servers that the key was updated. It will turn the grist
    on or off, based on the result.
3. Redis handler:
  - If any other server updated the key, we will receive a message here, and we will
    do what the activation status endpoint does, but only if our cache is outdated (has
    different update date). We will try to update the key in transaction, and if
    we fail, we will retry until we succeed or until the date we read from database
    is not the same as the date we read from cache.

*/

export class Activation implements IBilling {
  private readonly _activationManager: ActivationsManager;
  private readonly _activationReader: ActivationReader;
  private _pubSubUnsubscribe: () => void;
  private readonly _redisChannel = `activations:change`;
  private _lastCheck: number | null = null;
  private _currentCheck: Promise<void> | null = null;

  private readonly _log = new LogMethods<express.Request|null>('Activation ', (r: express.Request | null) => {
    if (!r) {
      return {};
    }

    const mreq = r as RequestWithLogin;
    return {
      org: mreq.org,
      email: mreq.user?.loginEmail,
      userId: mreq.userId,
      altSessionId: mreq.altSessionId,
    };
  });

  constructor(
    private _dbManager: HomeDBManager,
    private _gristServer: GristServer,
    keys?: string[]
  ) {
    // By default use embedded keys. This can be overridden for testing or by saas. But there
    // shouldn't be a way to override it in ext build.
    keys = keys || KEYS;
    this._activationManager = new ActivationsManager(this._dbManager);
    this._activationReader = new ActivationReader(this._activationManager, keys);


    this._pubSubUnsubscribe = _gristServer.getPubSubManager()
      .subscribe(this._redisChannel, (message) => this._readLatest());
  }

  public async close() {
    this._pubSubUnsubscribe();
  }

  public addEndpoints(app: express.Express): void {
    const server = this._gristServer;
    if (!server) {
      this._log.error(null, 'failed to add endpoints: undefined GristServer');
      return;
    }

    const requireInstallAdmin = this._gristServer.getInstallAdmin().getMiddlewareRequireAdmin();
    app.get('/api/activation/status', requireInstallAdmin, expressWrap(async (req, res) => {
      const data = await this._getActivationStatus();
      (req as RequestWithLogin).activation = data;
      return sendOkReply(null, res, data);
    }));

    // POST /api/activation/activate
    // Sets activation key on the instance, used only on self-hosted instances.
    app.post('/api/activation/activate', requireInstallAdmin, expressWrap(async (req, resp, next) => {
      // Read key from the body, this is a required field.
      const key = stringParam(req.body.key, 'key');

      // Check if the activation key is for the current installation.
      const {id} = await this._activationManager.current();

      // Decode it to get the content.
      const content = this._activationReader.readActivation(key);
      const match = content.installationId === id;
      const filled = Boolean(content.installationId);
      if (filled && !match) {
        throw new ApiError('Activation key is for a different installation', 400);
      }

      // Update the key in the database.
      await this._activationManager.setKey(key);

      // Reinitialize the reader to pick up the new key.
      await this._rereadAndNotify();

      (req as RequestWithLogin).activation = this._activationReader.activationStatus!;

      // Return success. The reader for the next request will pick up the new key.
      return sendOkReply(req, resp);
    }));
  }

  public addEventHandlers(): void {

  }

  public addWebhooks(): void {

  }

  public addPages(app: express.Express, middleware: express.RequestHandler[]): void {
    const server = this._gristServer;
    if (!server) {
      this._log.error(null, 'failed to add pages: undefined GristServer');
      return;
    }
    app.get('/activation', ...middleware, expressWrap(async (req, resp) => {
      return server.sendAppPage(req, resp, {path: 'app.html', status: 200, config: {}});
    }));
  }

  public addMiddleware(app: express.Express) {
    app.use('/admin', expressWrap(async (req, res, next) => {
      this._lastCheck = null;
      next();
    }));

    app.use(expressWrap(async (req, res, next) => {
      const mreq = req as RequestWithLogin;
      if (this._needsCheck()) {
        this._currentCheck ??= this._rereadAndNotify();
        await this._currentCheck;
        this._currentCheck = null;
        this._lastCheck = this._nowAligned();
      }
      mreq.activation = this._activationReader.activationStatus!;
      next();
    }));
  }

  /**
   * Reads the latest activation row and calculates the activation status.
   * This is called by other servers after they have calculated the activation status.
   */
  private async _readLatest() {
    await this._activationReader.readLatest();
    await this._turnGristOn(this._activationReader.activationStatus?.needKey === true);
  }

  /**
   * This method will force a check of the activation status, and will notify all servers about the change.
   */
  private async _rereadAndNotify() {
    await this._activationReader.check();
    await this._turnGristOn(this._activationReader.activationStatus?.needKey === true);
    await this._notifyServers();
  }

  private _nowAligned() {
    const nowFull = new Date().getTime();
    const aligned = nowFull - (nowFull % Math.max(1, this._readInterval()));
    return aligned;
  }

  private _needsCheck() {
    if (this._lastCheck === null ||
        this._readInterval() === 0 ||
        this._activationReader.activationStatus === null) {
      return true;
    }
    return this._nowAligned() > this._lastCheck;
  }

  private async _turnGristOn(needKey: boolean) {
    this._gristServer.setRestrictedMode(needKey);
  }

  // Interval is set to 1 hour by default, and can't be set to longer than 1 hour. Can be deactivated
  // by setting GRIST_CHECK_ACTIVATION_INTERVAL to 0.
  private _readInterval() {
    const value = optIntegerParam(
      Deps.GRIST_CHECK_ACTIVATION_INTERVAL, 'GRIST_CHECK_ACTIVATION_INTERVAL'
    );
    const hourInMs = 1000 * 60 * 60;
    if (value !== undefined) {
      return clamp(value, 0, hourInMs);
    }
    return hourInMs;
  }

  private async _notifyServers() {
    try {
      await this._gristServer.getPubSubManager().publish(this._redisChannel, 'change');
    } catch (e) {
      this._log.error(null, 'failed to notify servers about activation change', e);
      throw e;
    }
  }

  private async _getActivationStatus() {
    await this._rereadAndNotify();
    const result: ActivationStatus = {
      ...this._activationReader.activationStatus!,
      planName: null,
      keyPrefix: this._activationReader.keyHeader(),
    };
    return result;
  }
}
