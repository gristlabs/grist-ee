import {User} from 'app/gen-server/entity/User';
import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {appSettings} from 'app/server/lib/AppSettings';
import {InstallAdmin, SimpleInstallAdmin} from 'app/server/lib/InstallAdmin';
import log from 'app/server/lib/log';
import {MapWithTTL} from 'app/common/AsyncCreate';
import {getSetMapValue} from 'app/common/gutil';
import * as roles from 'app/common/roles';

// This implementation of InstallAdmin considers any user who is an owner of the org named by
// GRIST_INSTALL_ADMIN_ORG env var to be an installation admin. The named org must already
// exist in the home database.

export async function createInstallAdminUsingOrg(dbManager: HomeDBManager) {
  const installAdminOrg = appSettings.section('access').flag('installAdminOrg').readString({
    envVar: 'GRIST_INSTALL_ADMIN_ORG',
  });
  if (!installAdminOrg) {
    return new SimpleInstallAdmin(dbManager);
  }
  // Check that the org exists.
  const scope = {userId: dbManager.getPreviewerUserId()};
  try {
    const org = dbManager.unwrapQueryResult(await dbManager.getOrg(scope, installAdminOrg));
    log.info(`InstallAdminUsingOrg Admins are owners of ${installAdminOrg} (orgId ${org.id})`);
  } catch (err) {
    throw new Error(`Failed to get organization named by GRIST_INSTALL_ADMIN_ORG (${installAdminOrg}): ${err.message}`);
  }
  return new InstallAdminUsingOrg(dbManager, installAdminOrg);
}

const CACHE_TTL_MS = Number(process.env.GRIST_INSTALL_ADMIN_ORG_CACHE_TTL_MS) || 30_000;

class InstallAdminUsingOrg extends InstallAdmin {
  // To avoid a trip to the DB for each page load, we cache the set of owners (as user IDs),
  // with a TTL, so that we re-check every 30 seconds.
  private _cachedAdmins = new MapWithTTL<true, Promise<Set<number>>>(CACHE_TTL_MS);

  constructor(private _dbManager: HomeDBManager, public readonly installAdminOrg: string) {
    super();
  }

  public override async isAdminUser(user: User): Promise<boolean> {
    return (await this._getSetOfAdmins()).has(user.id);
  }

  private _getSetOfAdmins(): Promise<Set<number>> {
    return getSetMapValue(this._cachedAdmins, true, () => this._fetchSetOfAdmins());
  }

  private async _fetchSetOfAdmins(): Promise<Set<number>> {
    const scope = {userId: this._dbManager.getPreviewerUserId()};
    const members = this._dbManager.unwrapQueryResult(
      await this._dbManager.getOrgAccess(scope, this.installAdminOrg));

    // Installation admins are users with OWNER access to the special org.
    return new Set(members.users
      .filter(u => (u.access === roles.OWNER))
      .map(u => u.id));
  }
}
