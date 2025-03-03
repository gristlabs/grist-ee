import { AdminControlsAPI, IRecord } from 'app/common/AdminControlsAPI';
import { ApiError } from 'app/common/ApiError';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { RequestWithLogin } from 'app/server/lib/Authorizer';
import { HomeDBAdmin } from 'app/gen-server/lib/HomeDBAdmin';
import { expressWrap } from 'app/server/lib/expressWrap';
import { GristServer } from 'app/server/lib/GristServer';
import { LogMethods } from 'app/server/lib/LogMethods';
import { integerParam, optIntegerParam, optStringParam, stringParam } from 'app/server/lib/requestUtils';
import express, {Request} from 'express';
import { getLogMeta } from "app/server/lib/sessionUtils";

export const exposedForTests: { adminControls?: AdminControlsAPI } = {};

export function addAdminControlsEndpoints(
  dbManager: HomeDBManager,
  gristServer: GristServer,
  app: express.Express,
) {
  const log = new LogMethods("AdminControls", getLogMeta);
  const dbAdmin: AdminControlsAPI = new HomeDBAdmin(dbManager);
  exposedForTests.adminControls = dbAdmin;

  // All endpoints are currently controlled by the install admin.
  app.use('/api/admin-controls', gristServer.getInstallAdmin().getMiddlewareRequireAdmin());

  // Helper to keep each endpoint's implementation simpler and more consistent.
  function handle(handler: (req: RequestWithLogin) => unknown|Promise<unknown>) {
    return expressWrap(async (req: express.Request, res: express.Response) => {
      const mreq = req as RequestWithLogin;
      log.debug(mreq, req.path, req.query);
      res.json(await handler(mreq));
    });
  }

  async function wrapSingleRecord<Key, Fields>(what: string, result: Promise<{records: IRecord<Key, Fields>[]}>) {
    const records = (await result).records;
    if (!records.length) { throw new ApiError(`${what} not found`, 404); }
    return records[0];
  }

  // Helpers to parse common query parameters concisely.
  const orgid = (req: Request) => optIntegerParam(req.query.orgid, 'orgid');
  const wsid = (req: Request) => optIntegerParam(req.query.wsid,  'wsid');
  const docid = (req: Request) => optStringParam(req.query.docid, 'docid');
  const userid = (req: Request) => optIntegerParam(req.query.userid, 'userid');

  app.get('/api/admin-controls/users', handle((req) => {
    return dbAdmin.adminGetUsers({orgid: orgid(req), wsid: wsid(req), docid: docid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/users/:userid', handle((req) => {
    return wrapSingleRecord('User', dbAdmin.adminGetUsers({userid: integerParam(req.params.userid, 'userid')}));
  }));
  app.get('/api/admin-controls/orgs', handle((req) => {
    return dbAdmin.adminGetOrgs({orgid: orgid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/orgs/:orgid', handle((req) => {
    return wrapSingleRecord('Organization', dbAdmin.adminGetOrgs({orgid: integerParam(req.params.orgid, 'orgid')}));
  }));
  app.get('/api/admin-controls/workspaces', handle((req) => {
    return dbAdmin.adminGetWorkspaces({orgid: orgid(req), wsid: wsid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/workspaces/:wsid', handle((req) => {
    return wrapSingleRecord('Workspace', dbAdmin.adminGetWorkspaces({wsid: integerParam(req.params.wsid, 'wsid')}));
  }));
  app.get('/api/admin-controls/docs', handle((req) => {
    return dbAdmin.adminGetDocs({orgid: orgid(req), wsid: wsid(req), docid: docid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/docs/:docid', handle((req) => {
    return wrapSingleRecord('Document', dbAdmin.adminGetDocs({docid: stringParam(req.params.docid, 'docid')}));
  }));
}
