import {BaseAPI, IOptions} from 'app/common/BaseAPI';

// The interface exposed to the client via REST API, and also implemented by AdminControls on the
// server side.
export interface AdminControlsAPI {
  adminGetUsers(options: {orgid?: number, wsid?: number, docid?: string}): Promise<IUserRecords>;
  adminGetOrgs(options: {userid?: number}): Promise<IOrgRecords>;
  adminGetWorkspaces(options: {orgid?: number, userid?: number}): Promise<IWorkspaceRecords>;
  adminGetDocs(options: {orgid?: number, wsid?: number, userid?: number}): Promise<IDocRecords>;
}

//----------------------------------------------------------------------
// Types
//----------------------------------------------------------------------

export type IUserRecords = IRecords<number, IUserFields>;
export interface IUserFields {
  name: string;
  email: string;
  firstLoginAtMs: number|null;        // millisecond timestamp
  lastConnectionAtMs: number|null;    // millisecond timestamp
  hasApiKey: boolean;
  countOrgs: number;
  countWorkspaces: number;
  countDocs: number;
}

export interface ResourceAccessInfo {
  countUsers: number;       // Org members with access to this resource.
  countGuests: number;      // Users who aren't org members but have access to a contained document.
  hasEveryone?: boolean;
  hasAnon?: boolean;
}

export type IOrgRecords = IRecords<number, IOrgFields>;
export interface IOrgFields extends ResourceAccessInfo {
  name: string;
  domain: string|null;
  createdAtMs: number;
  isPersonal: boolean;
  ownerId?: number;
  countWorkspaces: number;
  countDocs: number;
}

export type IWorkspaceRecords = IRecords<number, IWorkspaceFields>;
export interface IWorkspaceFields extends ResourceAccessInfo {
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  removedAtMs?: number;
  // Parent info:
  orgId: number;
  orgName: string;
  orgDomain: string|null;
  orgIsPersonal: boolean;
  orgOwnerId?: number;
  countDocs: number;
  countExtraDocUsers: number;   // Org members with no access to this workspace, but with access to a contained doc.
}

export type IDocRecords = IRecords<string, IDocFields>;
export interface IDocFields extends ResourceAccessInfo {
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  removedAtMs?: number;
  isPinned: boolean;
  urlId?: string|null;
  createdBy?: number|null;
  type?: string|null;         // May be 'template' or 'tutorial', or unset/null for normal docs.
  usageRows?: number;
  usageDataBytes?: number;
  usageAttachmentBytes?: number;
  // Parent info:
  workspaceId: number;
  workspaceName: string;
  orgId: number;
  orgName: string;
  orgDomain: string|null;
  orgIsPersonal: boolean;
  orgOwnerId?: number;
}

export interface IRecords<IdType, FieldsType> {
  records: Array<{
    id: IdType;
    fields: FieldsType;
  }>;
}

//----------------------------------------------------------------------
// REST API client implementation.
//----------------------------------------------------------------------

export class AdminControlsAPIImpl extends BaseAPI implements AdminControlsAPI {
  private _adminUrl: string;

  constructor(homeUrl: string, options: IOptions = {}) {
    super(options);
    this._adminUrl = `${homeUrl}/api/admin-controls`;
  }

  public async adminGetUsers(options: {orgid?: number, wsid?: number, docid?: string}): Promise<IUserRecords> {
    const fullUrl = addParams(`${this._adminUrl}/users`, options);
    return this.requestJson(fullUrl, {method: 'GET'});
  }

  public async adminGetOrgs(options: {userid?: number}): Promise<IOrgRecords> {
    const fullUrl = addParams(`${this._adminUrl}/orgs`, options);
    return this.requestJson(fullUrl, {method: 'GET'});
  }

  public async adminGetWorkspaces(options: {orgid?: number, userid?: number}): Promise<IWorkspaceRecords> {
    const fullUrl = addParams(`${this._adminUrl}/workspaces`, options);
    return this.requestJson(fullUrl, {method: 'GET'});
  }

  public async adminGetDocs(options: {orgid?: number, wsid?: number, userid?: number}): Promise<IDocRecords> {
    const fullUrl = addParams(`${this._adminUrl}/docs`, options);
    return this.requestJson(fullUrl, {method: 'GET'});
  }
}

// Add the given {name: value} parameters to the passed-in URL.
function addParams(startUrl: string, options: {[name: string]: string|number|undefined}): string {
  const url = new URL(startUrl);
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined) {
      url.searchParams.append(name, String(value));
    }
  }
  return url.href;
}
