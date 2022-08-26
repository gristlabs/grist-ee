import {BaseAPI, IOptions} from 'app/common/BaseAPI';
import {addCurrentOrgToPath} from 'app/common/urlUtils';

export interface IActivationStatus {
  // Whether the instance is in good standing (i.e. not expired).
  inGoodStanding: boolean;
  // Whether the instance is in trial mode.
  isInTrial: boolean;
  // ISO8601 date when the trial or subscription ends.
  expirationDate: string | null;
}

export interface ActivationAPI {
  getActivationStatus(): Promise<IActivationStatus>;
}

export class ActivationAPIImpl extends BaseAPI implements ActivationAPI {
  constructor(private _homeUrl: string, options: IOptions = {}) {
    super(options);
  }

  public async getActivationStatus(): Promise<IActivationStatus> {
    return this.requestJson(`${this._url}/api/activation/status`, {method: 'GET'});
  }

  private get _url(): string {
    return addCurrentOrgToPath(this._homeUrl);
  }
}
