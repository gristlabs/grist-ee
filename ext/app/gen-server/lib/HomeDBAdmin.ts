import {
  AdminControlsAPI,
  IDocFields, IDocRecords,
  IOrgFields, IOrgRecords,
  IUserFields, IUserRecords,
  IWorkspaceFields, IWorkspaceRecords,
  ResourceAccessInfo
} from 'app/common/AdminControlsAPI';
import { GUEST } from 'app/common/roles';
import { AclRule } from 'app/gen-server/entity/AclRule';
import { Document } from 'app/gen-server/entity/Document';
import { Organization } from 'app/gen-server/entity/Organization';
import { User } from 'app/gen-server/entity/User';
import { Workspace } from 'app/gen-server/entity/Workspace';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { SelectQueryBuilder } from "typeorm";
import pick = require('lodash/pick');

// Postgres returns BigInts for counts, which we receive as strings. This type helps remember
// about the needed casts.
type PgNumber = number|string;
function getNumber(value: PgNumber|undefined): number { return Number(value || 0); }

interface ResourceQueryResults {
  countUsers: PgNumber;
  countWithGuests: PgNumber;
  countUsersOrgMembers?: PgNumber;
  hasEveryone?: boolean|number;
  hasAnon?: boolean|number;
}

export class HomeDBAdmin implements AdminControlsAPI {
  public constructor(private readonly _homeDb: HomeDBManager) {}

  public async adminGetUsers(options: {orgid?: number, wsid?: number, docid?: string}): Promise<IUserRecords> {
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


    type UserResourceCounts = Record<'countOrgs'|'countWorkspaces'|'countDocs', PgNumber>;
    const rawResultsMap = new Map<number, UserResourceCounts>(counts.map(r => [r.id, r]));
    const specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    const records = users
      .filter(user => !specialUserIds.has(user.id))     // Skip special users (like "everyone")
      .map((user: User) => {
        const id = user.id;
        const raw = rawResultsMap.get(id);
        const fields: IUserFields = {
          name: user.name,
          email: user.loginEmail!,
          firstLoginAtMs: user.firstLoginAt?.getTime() || null,
          lastConnectionAtMs: user.lastConnectionAt?.getTime() || null,
          hasApiKey: Boolean(user.apiKey),
          // TODO:
          // role for resource (if filtered by one resource)
          // is-billing-manager
          // is-admin (maybe separate install-admin from admin-admin?)
          countOrgs: getNumber(raw?.countOrgs),
          countWorkspaces: getNumber(raw?.countWorkspaces),
          countDocs: getNumber(raw?.countDocs),
        };
        return {id, fields};
      });
    return {records};
  }

  public async adminGetOrgs(options: {userid?: number}): Promise<IOrgRecords> {
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('orgs')
      .from(Organization, 'orgs')
      .leftJoin('orgs.aclRules', 'acl_rules')
      .chain(qb => this._addResourceAccessInfo(qb))
      .leftJoin('orgs.workspaces', 'workspaces')
      .leftJoin('workspaces.docs', 'docs')
      .addSelect('COUNT(DISTINCT workspaces.id)', 'countWorkspaces')
      .addSelect('COUNT(DISTINCT docs.id)', 'countDocs')
      .groupBy('orgs.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults & {countWorkspaces: PgNumber, countDocs: PgNumber};
    const rawResultsMap = new Map<number, Result>(result.raw.map(r => [r.orgs_id, r]));
    const records = result.entities.map((org: Organization) => {
      const id = org.id;
      const raw = rawResultsMap.get(id);
      const fields: IOrgFields = {
        ...pick(org, 'name', 'domain', 'ownerId'),
        createdAtMs: org.createdAt.getTime(),
        isPersonal: Boolean(org.ownerId),
        // Postgres returns BigInts for counts, which we see as strings here.
        countWorkspaces: getNumber(raw?.countWorkspaces),
        countDocs: getNumber(raw?.countDocs),
        ...this._extractResourceAccessInfo(raw)
      };
      return {id, fields};
    });
    return {records};
  }

  public async adminGetWorkspaces(options: {orgid?: number, userid?: number}): Promise<IWorkspaceRecords> {
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('workspaces')
      .from(Workspace, 'workspaces')
      .leftJoin('workspaces.aclRules', 'acl_rules')
      .leftJoinAndSelect('workspaces.org', 'org')
      .chain(qb => this._addResourceAccessInfo(qb, 'org'))
      .leftJoin('workspaces.docs', 'docs')
      .addSelect('COUNT(DISTINCT docs.id)', 'countDocs')
      .groupBy('workspaces.id, org.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults & {countDocs: PgNumber};
    const rawResultsMap = new Map<number, Result>(result.raw.map(r => [r.workspaces_id, r]));
    const records = result.entities.map((ws: Workspace) => {
      const id = ws.id;
      const raw = rawResultsMap.get(id);
      const fields: IWorkspaceFields = {
        name: ws.name,
        createdAtMs: ws.createdAt.getTime(),
        updatedAtMs: ws.updatedAt.getTime(),
        removedAtMs: ws.removedAt?.getTime(),
        orgId: ws.org.id,
        orgName: ws.org.name,
        orgDomain: ws.org.domain,
        orgIsPersonal: Boolean(ws.org.ownerId),
        orgOwnerId: ws.org.ownerId,
        countDocs: getNumber(raw?.countDocs),
        countExtraDocUsers: getNumber(raw?.countUsersOrgMembers) - getNumber(raw?.countUsers),
        ...this._extractResourceAccessInfo(raw)
      };
      return {id, fields};
    });
    return {records};
  }

  public async adminGetDocs(options: {orgid?: number, wsid?: number, userid?: number}): Promise<IDocRecords> {
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('docs')
      .from(Document, 'docs')
      .leftJoin('docs.aclRules', 'acl_rules')
      .leftJoinAndSelect('docs.workspace', 'workspace')
      .leftJoinAndSelect('workspace.org', 'org')
      .chain(qb => this._addResourceAccessInfo(qb, 'org'))
      .andWhere('docs.trunkId IS NULL')     // Exclude forks.
      .groupBy('docs.id, workspace.id, org.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults;
    const rawResultsMap = new Map<string, Result>(result.raw.map(r => [r.docs_id, r]));
    const records = result.entities.map((doc: Document) => {
      const id = doc.id;
      const raw = rawResultsMap.get(id);
      const fields: IDocFields = {
        ...pick(doc, 'name', 'isPinned', 'urlId', 'createdBy', 'type'),
        name: doc.name,
        createdAtMs: doc.createdAt.getTime(),
        updatedAtMs: doc.updatedAt.getTime(),
        removedAtMs: doc.removedAt?.getTime(),
        usageRows: doc.usage?.rowCount?.total,
        usageDataBytes: doc.usage?.dataSizeBytes,
        usageAttachmentBytes: doc.usage?.attachmentsSizeBytes,

        workspaceId: doc.workspace.id,
        workspaceName: doc.workspace.name,
        orgId: doc.workspace.org.id,
        orgName: doc.workspace.org.name,
        orgDomain: doc.workspace.org.domain,
        orgIsPersonal: Boolean(doc.workspace.org.ownerId),
        orgOwnerId: doc.workspace.org.ownerId,
        ...this._extractResourceAccessInfo(raw)
      };
      return {id, fields};
    });
    return {records};
  }

  // Expects a query that includes `acl_rules`. It is very specific to the particular
  // few queries that use this helper.
  private _addResourceAccessInfo<T>(queryBuilder: SelectQueryBuilder<T>, orgVar?: string) {
    const filterOutSpecial = `users.id NOT IN (:everyoneId, :anonId)`;
    return queryBuilder
      .leftJoin('acl_rules.group', 'groups')
      .chain(qb => this._homeDb._joinToAllGroupUsers(qb))
      .leftJoin(User, 'users', 'users.id IN (gu0.user_id, gu1.user_id, gu2.user_id, gu3.user_id)')

      // It takes extra effort to collect info about guests: we need to figure out who is a
      // member the org. We only do this when orgVar is given.
      .chain(qb => orgVar ? (qb
        .leftJoin(`${orgVar}.aclRules`, 'org_acl_rules')
        .leftJoin('org_acl_rules.group', 'org_groups', 'org_groups.name != :guestRole')
        .leftJoin('org_groups.memberUsers', 'org_member_users', 'users.id = org_member_users.id')
        // Users (including guests) who are members of the org. (Guests are those with access to a subresource.)
        .addSelect("COUNT(DISTINCT users.id) " +
          `FILTER(WHERE ${filterOutSpecial} AND org_member_users.id IS NOT NULL)`,
          'countUsersOrgMembers')
        // Users with non-guest access, who are members of the org.
        .addSelect("COUNT(DISTINCT users.id) " +
          `FILTER(WHERE ${filterOutSpecial} AND org_member_users.id IS NOT NULL AND groups.name != :guestRole)`,
          'countUsers')
      ) : (qb
        // Users with non-guest access. This branch is used when querying for orgs, so we don't
        // query separate org info. We also omit countOrgMembers.
        .addSelect("COUNT(DISTINCT users.id) " +
          `FILTER(WHERE ${filterOutSpecial} AND groups.name != :guestRole)`,
          'countUsers')
      ))
      .setParameter('guestRole', GUEST)

      // All users with access, including guests (those with access to a subresource).
      .addSelect(`COUNT(DISTINCT users.id) FILTER(WHERE ${filterOutSpecial})`, 'countWithGuests')
      .addSelect("MAX(CAST(users.id = :everyoneId AS INT))", 'hasEveryone')
      .addSelect("MAX(CAST(users.id = :anonId AS INT))", 'hasAnon')
      .setParameter('everyoneId', this._homeDb.getEveryoneUserId())
      .setParameter('anonId', this._homeDb.getAnonymousUserId());
  }

  private _extractResourceAccessInfo(raw?: ResourceQueryResults): ResourceAccessInfo {
    // Postgres returns BigInts for counts, which we see as strings here.
    const countUsers = getNumber(raw?.countUsers);
    const countWithGuests = getNumber(raw?.countWithGuests);
    // For an org, countUsersOrgMembers is undefined, but countUsers is conceptually equivalent.
    const countUsersOrgMembers = getNumber(raw?.countUsersOrgMembers ?? raw?.countUsers);
    return {
      countUsers,
      countGuests: countWithGuests - countUsersOrgMembers,
      ...(raw?.hasEveryone ? {hasEveryone: true} : {}),
      ...(raw?.hasAnon ? {hasAnon: true} : {}),
    };
  }
}
