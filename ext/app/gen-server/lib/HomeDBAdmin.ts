import { AclRule } from 'app/gen-server/entity/AclRule';
import { User } from 'app/gen-server/entity/User';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';

export interface UserResourceCounts {
  countOrgs: number;
  countWorkspaces: number;
  countDocs: number;
}

export class HomeDBAdmin {
  public constructor(private readonly _homeDb: HomeDBManager) {}

  public async getUsersWithResourceCounts(): Promise<Array<User & UserResourceCounts>> {
    const users = await this._homeDb.getUsers();

    // We query resource counts separately from users because the cross-join with user groups
    // makes it tricky to get rows for any users who have no resources at all.
    const counts = await this._homeDb.connection.createQueryBuilder()
      .select('users.id', 'id')
      .from(User, 'users')
      // hacky but portable way to do cross-join (?)
      .leftJoin(AclRule, 'acl_rules', '1 = 1')
      .chain(qb => this._homeDb._joinToAllGroupUsers(qb))
      .where('users.id IN (gu0.user_id, gu1.user_id, gu2.user_id, gu3.user_id)')
      .addSelect('COUNT(DISTINCT acl_rules.org_id)', 'countOrgs')
      .addSelect('COUNT(DISTINCT acl_rules.workspace_id)', 'countWorkspaces')
      .addSelect('COUNT(DISTINCT acl_rules.doc_id)', 'countDocs')
      .groupBy('users.id')
      .getRawMany();

    const countsMap = new Map<number, UserResourceCounts>(counts.map(r => [r.id, r]));
    const specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    return users
      .filter(user => !specialUserIds.has(user.id))     // Skip special users (like "everyone")
      .map((user: User): User & UserResourceCounts => {
        const count = countsMap.get(user.id);
        return Object.assign(user, {
          // Postgres returns BigInts for counts, which we see as strings here.
          countOrgs: count ? Number(count.countOrgs) : 0,
          countWorkspaces: count ? Number(count.countWorkspaces) : 0,
          countDocs: count ? Number(count.countDocs) : 0,
        });
      });
  }
}
