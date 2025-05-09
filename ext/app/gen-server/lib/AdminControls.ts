import { AdminControlsAPI } from 'app/common/AdminControlsAPI';
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
  const dbAdmin = new HomeDBAdmin(dbManager, gristServer);
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

  // Helpers to parse common query parameters concisely.
  const orgid = (req: Request) => optIntegerParam(req.query.orgid, 'orgid');
  const wsid = (req: Request) => optIntegerParam(req.query.wsid,  'wsid');
  const docid = (req: Request) => optStringParam(req.query.docid, 'docid');
  const userid = (req: Request) => optIntegerParam(req.query.userid, 'userid');

  app.get('/api/admin-controls/users', handle((req) => {
    return dbAdmin.adminGetUsers({orgid: orgid(req), wsid: wsid(req), docid: docid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/users/:userid', handle((req) => {
    return dbAdmin.adminGetUser(integerParam(req.params.userid, 'userid'));
  }));
  app.get('/api/admin-controls/orgs', handle((req) => {
    return dbAdmin.adminGetOrgs({orgid: orgid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/orgs/:orgid', handle((req) => {
    return dbAdmin.adminGetOrg(integerParam(req.params.orgid, 'orgid'));
  }));
  app.get('/api/admin-controls/workspaces', handle((req) => {
    return dbAdmin.adminGetWorkspaces({orgid: orgid(req), wsid: wsid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/workspaces/:wsid', handle((req) => {
    return dbAdmin.adminGetWorkspace(integerParam(req.params.wsid, 'wsid'));
  }));
  app.get('/api/admin-controls/docs', handle((req) => {
    return dbAdmin.adminGetDocs({orgid: orgid(req), wsid: wsid(req), docid: docid(req), userid: userid(req)});
  }));
  app.get('/api/admin-controls/docs/:docid', handle((req) => {
    return dbAdmin.adminGetDoc(stringParam(req.params.docid, 'docid'));
  }));
  app.get('/api/admin-controls/access', handle((req) => {
    return dbAdmin.adminGetResourceAccess({orgid: orgid(req), wsid: wsid(req), docid: docid(req)});
  }));

  // The "/:email" suffix (for User.loginEmail) serves as confirmation, to ensure the deletion is intentional.
  app.delete('/api/admin-controls/users/:userid/:email', handle(async (req) => {
    const newOwnerId = integerParam(req.query.newOwnerId, 'newOwnerId');
    const email = stringParam(req.params.email, 'email');
    return dbAdmin.adminDeleteUser(integerParam(req.params.userid, 'userid'), email, newOwnerId);
  }));
}
