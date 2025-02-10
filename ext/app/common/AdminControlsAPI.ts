import {BaseAPI, IOptions} from 'app/common/BaseAPI';

// The interface exposed to the client via REST API, and also implemented by AdminControls on the
// server side.
export interface AdminControlsAPI {
  adminGetUsers(options: {orgid?: number, wsid?: number, docid?: string}): Promise<IUserRecords>;
}

//----------------------------------------------------------------------
// Types
//----------------------------------------------------------------------

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
export interface IUserRecords {
  records: Array<{
    id: number;
    fields: IUserFields;
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
