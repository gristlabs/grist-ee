import {
  AdminControlsAPI,
  IDocFields, IDocRecords,
  IOrgFields, IOrgRecords,
  IRecord,
  IUserFields, IUserRecords,
  IWorkspaceFields, IWorkspaceRecords,
  ResourceAccessInfo
} from 'app/common/AdminControlsAPI';
import { ApiError } from 'app/common/ApiError';
import { countIf } from 'app/common/gutil';
import { GUEST } from 'app/common/roles';
import * as roles from 'app/common/roles';
import { PermissionData } from 'app/common/UserAPI';
import { AclRule } from 'app/gen-server/entity/AclRule';
import { Document } from 'app/gen-server/entity/Document';
import { Organization } from 'app/gen-server/entity/Organization';
import { User } from 'app/gen-server/entity/User';
import { Workspace } from 'app/gen-server/entity/Workspace';
import { Doom } from 'app/gen-server/lib/Doom';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { scrubUserFromBillingAccounts, scrubUserFromOrg } from "app/gen-server/lib/scrubUserFromOrg";
import { GristServer } from 'app/server/lib/GristServer';
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
  groupNames?: unknown;
}

export class HomeDBAdmin implements AdminControlsAPI {
  public constructor(
    private readonly _homeDb: HomeDBManager,
    private readonly _gristServer: GristServer,
  ) {}

  public async adminGetUsers(
    options: {orgid?: number, wsid?: number, docid?: string, userid?: number}
  ): Promise<IUserRecords> {
    const {orgid, wsid, docid, userid} = options;
    if (countIf([orgid, wsid, docid, userid], isSet) > 1) {
      throw new Error("adminGetUsers: At most one filter parameter is supported");
    }
    const isFilteredByResource = isSet(orgid) || isSet(wsid) || isSet(docid);

    // Note that this assumes one User corresponds to one Login. Our DB in theory allows multiple
    // logins per user, but in practice Grist app assumes in many places that there is only one.
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('user')
      .from(User, 'user')
      .leftJoinAndSelect('user.logins', 'logins')
      .leftJoinAndSelect(
        // Do counts in a subquery, since the iffy-looking cross join with _joinToAllGroupUsers()
        // turns out to be much faster than left-joining on users directly.
        ((subQuery) => subQuery
          .select('users.id', 'id')
          .from(User, 'users')
          .innerJoin(this._createAclRuleIdToUserIdQuery(), 'au', 'users.id = au.user_id')
          .leftJoin(AclRule, 'acl_rules', 'acl_rules.id = au.acl_rule_id')
          .chain(qb => {
            if (isFilteredByResource) {
              qb = qb
                .leftJoin('groups', 'acl_rules_group', 'acl_rules_group.id = acl_rules.group_id')
                .addSelect(this._homeDb.makeJsonArray('acl_rules_group.name'), 'group_names');
              if (isSet(docid)) { return qb.andWhere('acl_rules.doc_id = :docid', {docid}); }
              if (isSet(wsid)) { return qb.andWhere('acl_rules.workspace_id = :wsid', {wsid}); }
              if (isSet(orgid)) { return qb.andWhere('acl_rules.org_id = :orgid', {orgid}); }
            }
            // Only include counts when not filtering by a particular resource. It's hard to have
            // meaningful and useful counts when filtering.
            return qb
              // Join on each resource to be able to exclude soft-deleted resources from counts.
              .leftJoin('workspaces', 'ws', 'ws.id = acl_rules.workspace_id AND ws.removedAt IS NULL')
              .leftJoin('docs', 'doc', 'doc.id = acl_rules.doc_id AND doc.removedAt IS NULL')
              .leftJoin('doc.workspace', 'doc_ws', 'doc.removedAt IS NULL')
              .addSelect('COUNT(DISTINCT acl_rules.org_id)', 'countOrgs')
              .addSelect('COUNT(DISTINCT ws.id)', 'countWorkspaces')
              .addSelect('COUNT(DISTINCT doc.id) FILTER(WHERE doc_ws.removedAt IS NULL)', 'countDocs');
          })
          .groupBy('users.id')
        ),
        "counts",
        "counts.id = user.id"
      )
      .chain(qb => {
        // If filtering by one resource, return only users that have some access.
        if (isFilteredByResource) { return qb.where("counts.id IS NOT NULL"); }
        if (isSet(userid)) { return qb.where('user.id = :userid', {userid}); }
        return qb;
      })
      .getRawAndEntities();

    type UserResourceCounts = (Record<'countOrgs'|'countWorkspaces'|'countDocs', PgNumber>
      & {group_names: unknown});

    const rawResultsMap = new Map<number, UserResourceCounts>(result.raw.map(r => [r.id, r]));
    const specialUserIds = new Set(this._homeDb.getSpecialUserIds());
    specialUserIds.delete(this._homeDb.getSupportUserId());  // Don't exclude support user; they may be real.
    const records = result.entities
      .filter(user => !specialUserIds.has(user.id))     // Skip special users (like "everyone")
      .map((user: User) => {
        const id = user.id;
        const raw = rawResultsMap.get(id);
        const groupNames = raw?.group_names;
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
          ...(isFilteredByResource ? {} : {
            countOrgs: getNumber(raw?.countOrgs),
            countWorkspaces: getNumber(raw?.countWorkspaces),
            countDocs: getNumber(raw?.countDocs),
          }),
          ...(groupNames ? {
            access: getStrongestRole(this._homeDb.readJson(groupNames))
          } : {}),
        };
        return {id, fields};
      });
    return {records};
  }

  public async adminGetOrgs(options: {orgid?: number, userid?: number}): Promise<IOrgRecords> {
    const {orgid, userid} = options;
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('orgs')
      .from(Organization, 'orgs')
      .leftJoin('orgs.aclRules', 'acl_rules')
      .leftJoin('orgs.owner', 'owner')
      .chain(qb => this._addResourceAccessInfo(qb, userid))
      .leftJoin('orgs.workspaces', 'workspaces', 'workspaces.removedAt IS NULL')
      .leftJoin('workspaces.docs', 'docs', 'docs.removedAt IS NULL')
      .addSelect('COUNT(DISTINCT workspaces.id)', 'countWorkspaces')
      .addSelect('COUNT(DISTINCT docs.id)', 'countDocs')
      .addSelect('MAX(owner.name)', 'ownerName')
      .chain(qb => {
        if (isSet(orgid)) { qb = qb.andWhere('orgs.id = :orgid', {orgid}); }
        return qb;
      })
      .groupBy('orgs.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults & {countWorkspaces: PgNumber, countDocs: PgNumber, ownerName: string};
    const rawResultsMap = new Map<number, Result>(result.raw.map(r => [r.orgs_id, r]));
    const records = result.entities.map((org: Organization) => {
      const id = org.id;
      const raw = rawResultsMap.get(id);
      const fields: IOrgFields = {
        ...pick(org, 'name', 'domain', 'ownerId'),
        name: raw?.ownerName ? `@${raw.ownerName}` : org.name,
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

  public async adminGetWorkspaces(
    options: {orgid?: number, wsid?: number, userid?: number}
  ): Promise<IWorkspaceRecords> {
    const {orgid, wsid, userid} = options;
    const result = await this._homeDb.connection.createQueryBuilder()
      .select('workspaces')
      .from(Workspace, 'workspaces')
      .leftJoinAndSelect('workspaces.org', 'org')
      .leftJoin('org.owner', 'owner')
      .addSelect('MAX(owner.name)', 'ownerName')
      .leftJoin('workspaces.aclRules', 'acl_rules')
      .chain(qb => this._addResourceAccessInfo(qb, userid, 'org'))
      .leftJoin('workspaces.docs', 'docs', 'docs.removedAt IS NULL')
      .addSelect('COUNT(DISTINCT docs.id)', 'countDocs')
      .chain(qb => {
        if (isSet(orgid)) { qb = qb.andWhere('workspaces.org_id = :orgid', {orgid}); }
        if (isSet(wsid)) { qb = qb.andWhere('workspaces.id = :wsid', {wsid}); }
        return qb;
      })
      .groupBy('workspaces.id, org.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults & {countDocs: PgNumber, ownerName: string};
    const rawResultsMap = new Map<number, Result>(result.raw.map(r => [r.workspaces_id, r]));
    const records = result.entities.map((ws: Workspace) => {
      const id = ws.id;
      const raw = rawResultsMap.get(id);
      const fields: IWorkspaceFields = {
        name: ws.name,
        createdAtMs: ws.createdAt.getTime(),
        updatedAtMs: ws.updatedAt.getTime(),
        ...(ws.removedAt ? {removedAtMs: ws.removedAt.getTime()} : {}),
        orgId: ws.org.id,
        orgName: raw?.ownerName ? `@${raw.ownerName}` : ws.org.name,
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

  public async adminGetDocs(
    options: {orgid?: number, wsid?: number, docid?: string, userid?: number}
  ): Promise<IDocRecords> {
    const {orgid, wsid, docid, userid} = options;

    const result = await this._homeDb.connection.createQueryBuilder()
      .select('docs')
      .from(Document, 'docs')
      .leftJoin('docs.aclRules', 'acl_rules')
      .leftJoinAndSelect('docs.workspace', 'workspace')
      .leftJoinAndSelect('workspace.org', 'org')
      .leftJoin('org.owner', 'owner')
      .addSelect('MAX(owner.name)', 'ownerName')
      .chain(qb => this._addResourceAccessInfo(qb, userid, 'org'))
      .chain(qb => {
        if (isSet(orgid)) { qb = qb.andWhere('workspace.org_id = :orgid', {orgid}); }
        if (isSet(wsid)) { qb = qb.andWhere('docs.workspace_id = :wsid', {wsid}); }
        if (isSet(docid)) { qb = qb.andWhere('docs.id = :docid', {docid}); }
        return qb;
      })
      .andWhere('docs.trunkId IS NULL')     // Exclude forks.
      .groupBy('docs.id, workspace.id, org.id')
      .getRawAndEntities();

    type Result = ResourceQueryResults & { ownerName: string};
    const rawResultsMap = new Map<string, Result>(result.raw.map(r => [r.docs_id, r]));
    const records = result.entities.map((doc: Document) => {
      const id = doc.id;
      const raw = rawResultsMap.get(id);
      // Doc is considered removed if either itself or its containing workspace is removed.
      const removedAt = doc.removedAt || doc.workspace.removedAt;
      const fields: IDocFields = {
        ...pick(doc, 'name', 'isPinned', 'urlId', 'createdBy', 'type'),
        name: doc.name,
        createdAtMs: doc.createdAt.getTime(),
        updatedAtMs: doc.updatedAt.getTime(),
        ...(removedAt ? {removedAtMs: removedAt.getTime()} : {}),
        ...(doc.usage ? {
          usageRows: doc.usage.rowCount?.total,
          usageDataBytes: doc.usage.dataSizeBytes,
          usageAttachmentBytes: doc.usage.attachmentsSizeBytes,
        } : {}),
        workspaceId: doc.workspace.id,
        workspaceName: doc.workspace.name,
        orgId: doc.workspace.org.id,
        orgName: raw?.ownerName ? `@${raw.ownerName}` : doc.workspace.org.name,
        orgDomain: doc.workspace.org.domain,
        orgIsPersonal: Boolean(doc.workspace.org.ownerId),
        orgOwnerId: doc.workspace.org.ownerId,
        ...this._extractResourceAccessInfo(raw)
      };
      return {id, fields};
    });
    return {records};
  }

  public async adminGetResourceAccess(
    options: {orgid?: number, wsid?: number, docid?: string}
  ): Promise<PermissionData> {
    const {orgid, wsid, docid} = options;
    if (countIf([orgid, wsid, docid], isSet) > 1) {
      throw new Error("adminGetResourceAccess: At most one filter parameter is supported");
    }
    const scope = {userId: this._homeDb.getPreviewerUserId()};
    const result = await (
      isSet(orgid) ? this._homeDb.getOrgAccess(scope, orgid) :
      isSet(wsid) ? this._homeDb.getWorkspaceAccess(scope, wsid) :
      isSet(docid) ? this._homeDb.getDocAccess({...scope, urlId: docid}) :
      null);
    if (!result) {
      throw new Error("adminGetResourceAccess: Exactly one filter parameter is required");
    }
    return this._homeDb.unwrapQueryResult(result);
  }

  public adminGetUser(userid: number) { return getFirstRecord('User', this.adminGetUsers({userid})); }
  public adminGetOrg(orgid: number) { return getFirstRecord('Organization', this.adminGetOrgs({orgid})); }
  public adminGetWorkspace(wsid: number) { return getFirstRecord('Workspace', this.adminGetWorkspaces({wsid})); }
  public adminGetDoc(docid: string) { return getFirstRecord('Document', this.adminGetDocs({docid})); }

  // Delete the user, which means:
  // - Remove them from every org they have access to, reassigning owned resources to newOwnerId.
  // - Delete their personal org.
  // - Delete the user from the database.
  // - Delete the user from notifications and login services.
  // Correct email (normalized, i.e. lowercase, as returned by adminGetUsers()) is required too,
  // to reduce the chance of accidental deletions, since it is a more intentional identifier
  // that's harder to get wrong by mistake.
  // Returns the record for the user as seen before the deletion.
  public async adminDeleteUser(userId: number, email: string, newOwnerId: number): Promise<IUserFields> {
    const server = this._gristServer;
    const permitStore = server.getPermitStore();
    const notifier = server.getNotifier();
    const loginSystem = await server.resolveLoginSystem();
    const homeApiUrl: string = server.getHomeInternalUrl().replace(/\/$/, '');
    const doom = new Doom(this._homeDb, permitStore, notifier, loginSystem, homeApiUrl);
    const user = await this._homeDb.getUser(userId);
    if (!user || user.loginEmail !== email) {
      throw new ApiError(`User ${userId} with email "${email}" not found`, 404);
    }
    const newOwner = await this._homeDb.getUser(newOwnerId);
    if (!newOwner) {
      throw new ApiError(`New owner user ${newOwnerId} not found`, 404);
    }

    // Fetch the initial state of the user in the usual admin format.
    const deletedUserInfo: IUserFields = (await this.adminGetUsers({userid: userId})).records[0].fields;

    // Scrub the user from orgs they are in.
    const orgs = this._homeDb.unwrapQueryResult(
      await this._homeDb.getOrgs(userId, null, {ignoreEveryoneShares: true}));

    // TODO It would make sense to do _everything_ in a transaction (including query and
    // deleteUser()), once this is easier to do.
    await this._homeDb.runInTransaction(undefined, async (manager) => {
      for (const org of orgs) {
        // Omit scrubbing from personal org; deleteUser() will delete it.
        if (org.ownerId !== userId) {
          await scrubUserFromOrg(org.id, userId, newOwnerId, manager);
        }
      }

      await scrubUserFromBillingAccounts(userId, newOwnerId, manager);
    });

    // Do the actual deletion of the user.
    await doom.deleteUser(userId);

    return deletedUserInfo;
  }

  // Expects a query that includes `acl_rules`. It is very specific to the particular
  // few queries that use this helper.
  // In particular, it adds .having() clause, so the outer query must use .groupBy().
  private _addResourceAccessInfo<T>(queryBuilder: SelectQueryBuilder<T>, userid?: number, orgVar?: string) {
    const filterOutSpecial = `users.id NOT IN (:everyoneId, :anonId)`;

    return queryBuilder
      .leftJoin('acl_rules.group', 'groups')
      .innerJoin(this._createAclRuleIdToUserIdQuery(), 'au', 'acl_rules.id = au.acl_rule_id')
      .leftJoin(User, 'users', 'users.id = au.user_id')

      // It takes extra effort to collect info about guests: we need to figure out who is a
      // member the org. We only do this when orgVar is given.
      .chain(qb => orgVar ?
        (
          qb.leftJoin(subQuery =>
            (subQuery
              .from(AclRule, 'org_acl_rules')
              .leftJoin('org_acl_rules.group', 'org_groups')
              .leftJoin('org_groups.memberUsers', 'org_member_users')
              .where('org_groups.name != :guestRole')
              .select('org_acl_rules.org_id', 'org_id')
              .addSelect('org_member_users.id', 'user_id')
              .groupBy('org_acl_rules.org_id, org_member_users.id')
            ),
            'org_members',
            // Join condition is such that a user is an org member if and only if org_members.user_id is not NULL.
            `org_members.org_id = ${orgVar}.id AND org_members.user_id = users.id`
          )
          // Members of the org with access to this resource, including guest access (ie access to a subresource).
          .addSelect(`COUNT(DISTINCT org_members.user_id) ` +
            `FILTER(WHERE ${filterOutSpecial})`,
            'countUsersOrgMembers')
          // Members of the org with direct (non-guest) access to this resource.
          .addSelect(`COUNT(DISTINCT org_members.user_id) ` +
            `FILTER(WHERE ${filterOutSpecial} AND groups.name != :guestRole)`,
            'countUsers')
        ) : (qb
          // Users with direct (non-guest) access. This branch is used when querying for orgs, so we don't
          // query separate org membership info. We also omit countUsersOrgMembers.
          .addSelect("COUNT(DISTINCT users.id) " +
            `FILTER(WHERE ${filterOutSpecial} AND groups.name != :guestRole)`,
            'countUsers')
        )
      )
      .setParameter('guestRole', GUEST)
      // All users with access, including guests (those with access to a subresource).
      .addSelect(`COUNT(DISTINCT users.id) FILTER(WHERE ${filterOutSpecial})`, 'countWithGuests')
      .addSelect("MAX(CAST((users.id = :everyoneId) AS INT))", 'hasEveryone')
      .addSelect("MAX(CAST((users.id = :anonId) AS INT))", 'hasAnon')
      .setParameter('everyoneId', this._homeDb.getEveryoneUserId())
      .setParameter('anonId', this._homeDb.getAnonymousUserId())
      .chain(qb => {
        if (isSet(userid)) {
          return qb
            .having('COUNT(DISTINCT groups.name) FILTER(WHERE users.id = :filterUserId) > 0')
            .addSelect(this._homeDb.makeJsonArray('DISTINCT groups.name') + ' FILTER(WHERE users.id = :filterUserId)',
              'groupNames')
            .setParameter('filterUserId', userid);
        }
        return qb;
      });
  }

  private _extractResourceAccessInfo(raw?: ResourceQueryResults): ResourceAccessInfo {
    // Postgres returns BigInts for counts, which we see as strings here.
    const countUsers = getNumber(raw?.countUsers);
    const countWithGuests = getNumber(raw?.countWithGuests);
    // For an org, countUsersOrgMembers is undefined, but countUsers is conceptually equivalent.
    const countUsersOrgMembers = getNumber(raw?.countUsersOrgMembers ?? raw?.countUsers);
    const groupNames = raw?.groupNames ? this._homeDb.readJson(raw?.groupNames) : [];
    return {
      countUsers,
      countGuests: countWithGuests - countUsersOrgMembers,
      ...(raw?.hasEveryone ? {hasEveryone: true} : {}),
      ...(raw?.hasAnon ? {hasAnon: true} : {}),
      ...(groupNames.length > 0 ? {access: getStrongestRole(groupNames)} : {}),
    };
  }

  // Produce query for a join similar to that in HomeDBManager's _joinToAllGroupUsers,
  // but for our purpose, this implementations seems to be many times faster.
  // This is to be used in a subquery, and yields (acl_rule_id, user_id) records, which
  // identify an acl_rule record and a user_id it applies to.
  private _createAclRuleIdToUserIdQuery(): string {
    const allQueries: string[] = [];
    const conn = this._homeDb.connection;
    for (let groupLevel = 0; groupLevel <= 3; groupLevel++) {
      let subQb = conn.createQueryBuilder()
        .addSelect('ac.id', 'acl_rule_id')
        .addSelect('gu.user_id', 'user_id')
        .from(AclRule, 'ac');
      let joinKey = 'ac.group_id';
      for (let i = 0; i < groupLevel; i++) {
        subQb = subQb.innerJoin('group_groups', `gg${i}`, `${joinKey} = gg${i}.group_id`);
        joinKey = `gg${i}.subgroup_id`;
      }
      subQb = subQb.innerJoin('group_users', 'gu', `${joinKey} = gu.group_id`);
      allQueries.push(subQb.getQuery());
    }
    return '(' + allQueries.join(" UNION ALL ") + ')';
  }
}

function getStrongestRole(roleList: roles.Role[]): roles.Role{
  return roleList.reduce((result, role) => roles.getStrongestRole(result, role));
}

function isSet(param: number|string|undefined): param is number|string{
  return param != null;
}

async function getFirstRecord<Key, Fields>(what: string, result: Promise<{records: IRecord<Key, Fields>[]}>) {
  const records = (await result).records;
  if (!records.length) { throw new ApiError(`${what} not found`, 404); }
  return records[0];
}
