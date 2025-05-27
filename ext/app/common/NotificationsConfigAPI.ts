import {NotificationPrefs, NotificationPrefsBundle} from 'app/common/NotificationPrefs';
import {BaseAPI, IOptions} from 'app/common/BaseAPI';

//----------------------------------------------------------------------
// Types
//----------------------------------------------------------------------

// The interface exposed to the client via REST API, and also implemented by
// the server-side NotificationsConfig.
export interface NotificationsConfigAPI {
  getNotificationsConfig(): Promise<NotificationPrefsBundle>;
  setNotificationsConfig(config: Partial<NotificationPrefsBundle>): Promise<void>;
}

//----------------------------------------------------------------------
// REST API client implementation.
//----------------------------------------------------------------------

const DEFAULT_CONFIG: Required<NotificationPrefs> = {
  docChanges: false,
  comments: 'relevant',
};

// Given document defaults and optionally a user's preferences, fill out all values.
export function fillNotificationPrefs(
  docDefaults: NotificationPrefs, currentUser?: NotificationPrefs
): Required<NotificationPrefs> {
  return {
    ...DEFAULT_CONFIG,
    ...docDefaults,
    comments: docDefaults.comments ?? (docDefaults.docChanges ? 'all' : 'relevant'),
    ...currentUser,
  };
}

export class NotificationsConfigAPIImpl extends BaseAPI implements NotificationsConfigAPI {
  constructor(private _docBaseUrl: string, options: IOptions = {}) {
    super(options);
  }

  public async getNotificationsConfig(): Promise<NotificationPrefsBundle> {
    return this.requestJson(`${this._docBaseUrl}/notifications-config`, {method: 'GET'});
  }
  public async setNotificationsConfig(config: Partial<NotificationPrefsBundle>): Promise<void> {
    const body = JSON.stringify(config);
    return this.requestJson(`${this._docBaseUrl}/notifications-config`, {method: 'POST', body});
  }
}
