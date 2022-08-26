import {AppModel, getHomeUrl} from 'app/client/models/AppModel';
import {ActivationAPI, ActivationAPIImpl, IActivationStatus} from 'app/common/ActivationAPI';
import {bundleChanges, Disposable, Observable} from 'grainjs';

export interface ActivationModel {
  // Activation status (e.g. plan expiration date).
  readonly activationStatus: Observable<IActivationStatus|null>;

  // Indicates whether the request for activation status failed with unauthorized.
  // Initialized to false until the request is made.
  readonly isUnauthorized: Observable<boolean>;

  // Fetches activation status if the user is a plan manager.
  fetchActivationStatus(forceReload?: boolean): Promise<void>;
}

/**
 * Creates the model for the ActivationPage. See ext/app/client/ui/ActivationPage for details.
 */
export class ActivationModelImpl extends Disposable implements ActivationModel {
  // Activation status (e.g. plan expiration date).
  public readonly activationStatus: Observable<IActivationStatus|null> = Observable.create(this, null);

  // Indicates whether the request for activation status failed with unauthorized.
  // Initialized to false until the request is made.
  public readonly isUnauthorized: Observable<boolean> = Observable.create(this, false);

  private readonly _activationAPI: ActivationAPI = new ActivationAPIImpl(getHomeUrl());

  constructor(_appModel: AppModel) {
    super();
  }

  /**
   * Fetches activation status if the user is a plan manager.
   *
   * @param {boolean} forceReload Re-fetches and updates already fetched data if set.
   */
  public async fetchActivationStatus(forceReload: boolean = false): Promise<void> {
    if (!forceReload && this.activationStatus.get() !== null) { return; }

    try {
      this.activationStatus.set(null);
      const status = await this._activationAPI.getActivationStatus();
      bundleChanges(() => {
        this.activationStatus.set(status);
        this.isUnauthorized.set(false);
      });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        this.isUnauthorized.set(true);
      }
      throw e;
    }
  }
}
