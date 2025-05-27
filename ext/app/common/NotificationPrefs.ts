/**
 * Represents per-document Notifications preferences.
 */

export type CommentSetting = 'all' | 'relevant' | 'none';

export interface NotificationPrefs {
  docChanges?: boolean;
  comments?: CommentSetting;
  // webhookGroups?: {[name: string]: boolean}; -- proposed, not yet used.
}

export interface NotificationPrefsBundle {
  // Defaults for all collaborators for a document.
  docDefaults?: NotificationPrefs;

  // Values for the current user, which, when set, override what's in docDefaults.
  currentUser?: NotificationPrefs;
}
