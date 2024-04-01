import { HomeDBManager } from 'app/gen-server/lib/HomeDBManager';
import { ActivationReader, addActivationMiddleware } from 'app/server/lib/ActivationReader';
import { RequestWithLogin } from 'app/server/lib/Authorizer';
import { expressWrap } from 'app/server/lib/expressWrap';
import { GristServer } from 'app/server/lib/GristServer';
import { IBilling } from 'app/server/lib/IBilling';
import { LogMethods } from 'app/server/lib/LogMethods';
import { sendOkReply } from 'app/server/lib/requestUtils';
import * as express from 'express';

export class Activation implements IBilling {
  private readonly _activationReader = new ActivationReader(this._dbManager);

  private readonly _log = new LogMethods('Activation ', (r: express.Request | undefined) => {
    if (!r) { return {}; }

    const mreq = r as RequestWithLogin;
    return {
      org: mreq.org,
      email: mreq.user?.loginEmail,
      userId: mreq.userId,
      altSessionId: mreq.altSessionId,
    };
  });

  constructor(private _dbManager: HomeDBManager, private _gristServer: GristServer) {
    this._activationReader.initialize().catch(() =>
      this._log.error(undefined, 'failed to initialize ActivationReader'));
  }

  public addEndpoints(app: express.Express): void {
    const server = this._gristServer;
    if (!server) {
      this._log.error(undefined, 'failed to add endpoints: undefined GristServer');
      return;
    }

    const requireInstallAdmin = this._gristServer.getInstallAdmin().getMiddlewareRequireAdmin();
    app.get('/api/activation/status', requireInstallAdmin, expressWrap(async (req, res) => {
      const data = await this._getActivationStatus();
      return sendOkReply(null, res, data);
    }));
  }

  public addEventHandlers(): void {

  }

  public addWebhooks(): void {

  }

  public addPages(app: express.Express, middleware: express.RequestHandler[]): void {
    const server = this._gristServer;
    if (!server) {
      this._log.error(undefined, 'failed to add pages: undefined GristServer');
      return;
    }

    app.get('/activation', ...middleware, expressWrap(async (req, resp) => {
      return server.sendAppPage(req, resp, {path: 'app.html', status: 200, config: {}});
    }));
  }

  public async addMiddleware(app: express.Express) {
    await addActivationMiddleware(this._dbManager, app);
  }

  private async _getActivationStatus() {
    const {key, trial, needKey} = this._activationReader.check();
    return {
      inGoodStanding: !needKey,
      isInTrial: Boolean(trial),
      expirationDate: (key?.expirationDate || trial?.expirationDate) ?? null,
    };
  }
}
