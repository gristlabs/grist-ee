import { AdminControlsAPI, IUserFields, IUserRecords } from 'app/common/AdminControlsAPI';
import { User } from 'app/gen-server/entity/User';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { RequestWithLogin } from 'app/server/lib/Authorizer';
import { HomeDBAdmin, UserResourceCounts } from 'app/gen-server/lib/HomeDBAdmin';
import { expressWrap } from 'app/server/lib/expressWrap';
import { GristServer } from 'app/server/lib/GristServer';
import { LogMethods } from 'app/server/lib/LogMethods';
import { optIntegerParam, optStringParam } from 'app/server/lib/requestUtils';
import * as express from 'express';
import { getLogMeta } from "app/server/lib/sessionUtils";

export class AdminControls implements AdminControlsAPI {
  private readonly _log = new LogMethods("AdminControls", getLogMeta);
  private _dbAdmin: HomeDBAdmin;

  constructor(dbManager: HomeDBManager, private _gristServer: GristServer) {
    this._dbAdmin = new HomeDBAdmin(dbManager);
  }

  public async adminGetUsers(options: {orgid?: number, wsid?: number, docid?: string}): Promise<IUserRecords> {
    // TODO Implement filtering.
    const users = await this._dbAdmin.getUsersWithResourceCounts();
    const records = users.map((user: User & UserResourceCounts) => {
      const id = user.id;
      const fields: IUserFields = {
        name: user.name,
        email: user.loginEmail!,
        firstLoginAtMs: user.firstLoginAt?.getTime() || null,
        lastConnectionAtMs: user.lastConnectionAt?.getTime() || null,
        hasApiKey: Boolean(user.apiKey),
        countOrgs: user.countOrgs,
        countWorkspaces: user.countWorkspaces,
        countDocs: user.countDocs,
        // TODO:
        // role for resource (if filtered by one resource)
        // is-billing-manager
        // is-admin (maybe separate install-admin from admin-admin?)
      };
      return {id, fields};
    });
    return {records};
  }

  public addEndpoints(app: express.Express): void {
    const router = express.Router();
    app.use('/api/admin-controls', router);

    // All endpoints are currently controlled by the install admin.
    router.use(this._gristServer.getInstallAdmin().getMiddlewareRequireAdmin());

    router.get('/users', this._handle((req) => {
      return this.adminGetUsers(this._parseQuery(req.query, ['orgid', 'wsid', 'docid']));
    }));
    router.get('/users/:userid', this._handle((req) => {
      // TODO const userid = integerParam(req.params.userid, 'userid');
    }));
    router.get('/orgs', this._handle((req) => {
      // TODO this._parseQuery(req.query, ['userid']);
    }));
    router.get('/orgs/:orgid', this._handle((req) => {
      // TODO const orgid = integerParam(req.params.orgid, 'orgid');
    }));
    router.get('/workspaces', this._handle((req) => {
      // TODO this._parseQuery(req.query, ['orgid', 'userid']);
    }));
    router.get('/workspaces/:wsid', this._handle((req) => {
      // TODO const wsid = integerParam(req.params.wsid, 'wsid');
    }));
    router.get('/docs', this._handle((req) => {
      // TODO this._parseQuery(req.query, ['orgid', 'wsid', 'userid']);
    }));
    router.get('/docs/:docid', this._handle((req) => {
      // TODO const docid = stringParam(req.params.docid, 'docid');
    }));
  }

  // Helper to keep each endpoint's implementation simpler and more consistent.
  private _handle(handler: (req: RequestWithLogin) => unknown|Promise<unknown>) {
    return expressWrap(async (req: express.Request, res: express.Response) => {
      const mreq = req as RequestWithLogin;
      this._log.debug(mreq, req.path, req.query);
      res.json(await handler(mreq));
    });
  }

  // All endpoints support subsets of the same parameters, so we can use a single helper for all.
  private _parseQuery(query: QueryParams, allowedParams: Array<keyof typeof queryParsers>) {
    return Object.fromEntries(allowedParams.map((name) => [name, queryParsers[name](query)]));
  }
}

type QueryParams = express.Request["query"];

// Helpers for parsing the common parameters.
const queryParsers = {
  orgid: (query: QueryParams) => optIntegerParam(query.orgid, 'orgid'),
  wsid:  (query: QueryParams) => optIntegerParam(query.wsid,  'wsid'),
  docid: (query: QueryParams) => optStringParam(query.docid, 'docid'),
  userid: (query: QueryParams) => optIntegerParam(query.userid, 'userid'),
};
