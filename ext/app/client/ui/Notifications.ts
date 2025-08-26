/**
 * UI for configuring notifications for document changes.
 */
import {makeT} from 'app/client/lib/localization';
import {DocInfo} from 'app/client/models/DocPageModel';
import {AdminSection, AdminSectionItem} from 'app/client/ui/AdminPanelCss';
import {cssSpinnerBox} from 'app/client/ui/AdminTogglesCss';
import {cssLink} from 'app/client/ui2018/links';
import {select} from 'app/client/ui2018/menus';
import {theme, vars} from 'app/client/ui2018/cssVars';
import {loadingSpinner} from 'app/client/ui2018/loaders';
import {toggleSwitch} from 'app/client/ui2018/toggleSwitch';
import {ApiError} from 'app/common/ApiError';
import {commonUrls} from 'app/common/gristUrls';
import {fillNotificationPrefs, NotificationsConfigAPIImpl} from "app/common/NotificationsConfigAPI";
import {NotificationPrefs, NotificationPrefsBundle} from "app/common/NotificationPrefs";
import {getGristConfig} from "app/common/urlUtils";
import {DocAPI} from 'app/common/UserAPI';
import {Computed, dom, DomContents, IDisposableOwner, makeTestId, Observable, styled} from 'grainjs';
import {isEnterpriseDeployment} from 'app/client/lib/enterpriseDeploymentCheck';
import get = require('lodash/get');
import set = require('lodash/set');
import pick = require('lodash/pick');
import {debounce} from 'perfect-debounce';

const t = makeT('Notifications');
const testId = makeTestId('test-notifications-');
const SAVE_DEBOUNCE_MS = 100;

type CommentSetting = 'all' | 'relevant' | 'none';

/**
 * Build configuration for doc-change and comment notifications.
 * These only work in enterprise configuration, and when a notifier is configured. We return null
 * if either of these is false, or if notifications don't apply to this doc (e.g. a fork or a snapshot).
 */
export function buildNotificationsConfig(owner: IDisposableOwner, docAPI: DocAPI, doc: DocInfo|null): DomContents {
  if (!isEnterpriseDeployment() || !getGristConfig().notifierEnabled) {
    return null;
  }

  if (!doc || doc.isFork || doc.isSnapshot) {
    // Don't show notifications config for forks or snapshots. We don't support getting or setting it.
    return null;
  }

  const api = new NotificationsConfigAPIImpl(docAPI.getBaseUrl(), docAPI.options);
  const isLoading = Observable.create(owner, true);
  const isSaving = Observable.create(owner, false);
  const isAccessDenied = Observable.create(owner, false);
  const errorMsg = Observable.create(owner, "");
  const userConfig = Observable.create<NotificationPrefs>(owner, {});
  let fullPrefsToSave: Partial<NotificationPrefsBundle> = {};

  function setUserConfig(prefs: NotificationPrefs) {
    userConfig.set(prefs);
    fullPrefsToSave.currentUser = userConfig.get();
    save();
  }

  // Little helper to skip callback when owner has been disposed.
  function unlessDisposed<T extends unknown[]>(callback: (...args: T) => void): (...args: T) => void {
    // Check any of the objects that will get disposed, since all would get disposed together.
    return (...args: T) => isLoading.isDisposed() ? undefined : callback(...args);
  }
  async function doSave() {
    const prefs = fullPrefsToSave;
    fullPrefsToSave = {};
    isSaving.set(true);
    return api.setNotificationsConfig(prefs)
      .then(unlessDisposed(() => errorMsg.set('')))
      .catch(unlessDisposed(err => errorMsg.set(err.message)))
      .finally(unlessDisposed(() => isSaving.set(false)));
  }
  const debouncedSave = debounce(doSave, SAVE_DEBOUNCE_MS);
  function save() {
    isSaving.set(true);
    void(debouncedSave());
  }

  // Load the configuration.
  api.getNotificationsConfig()
    .then(unlessDisposed(prefs => {
      userConfig.set(pick(prefs.currentUser || {}, 'docChanges', 'comments'));
    }))
    .catch(unlessDisposed(err => {
      if (err instanceof ApiError && err.status === 403) {
        userConfig.set({docChanges: false, comments: 'none'});
        isAccessDenied.set(true);
      } else {
        errorMsg.set(err.message);
      }
    }))
    .finally(unlessDisposed(() => isLoading.set(false)));

  // Merge the default config and the user config. This is the actual value that applies to the user.
  const mergedConfig = Computed.create<Required<NotificationPrefs>>(owner, use =>
    fillNotificationPrefs({}, use(userConfig)));

  // Build a setting, consisting of observables and methods used by the UI.
  function buildSetting<ValType>(owner_: IDisposableOwner, path: string): Observable<ValType> {
    return Computed.create<ValType>(owner_, use => get(use(mergedConfig), path))
      .onWrite(val => setUserConfig(set(structuredClone(userConfig.get()), path, val)));
  }

  const docEdits = buildSetting<boolean>(owner, 'docChanges');
  const comments = buildSetting<CommentSetting>(owner, 'comments');

  // Note that this single DOM construction represents UI for the owner or the end user. These
  // differ mainly in that the owner sees an extra column of settings, and an extra row with
  // labels for the columns.
  return dom.create(AdminSection,
    [t('Notifications'), cssSaving(t('Saving...'), cssSaving.cls('-visible', isSaving))],
    [
      dom.domComputed(use => {
        const loading = use(isLoading);
        if (loading) {
          return cssSpinnerBox(loadingSpinner());
        }

        const accessDenied = use(isAccessDenied);
        return [
          dom('div',
            accessDenied
              ? t(
                  'You have public access to this document. ' +
                  "If you wish to receive notifications, the document's " +
                  'owner must add you as a collaborator. {{learnMoreLink}}.',
                  {
                    learnMoreLink: cssLink(
                      {href: commonUrls.helpSharing, target: '_blank'},
                      t('Learn more about sharing')
                    ),
                  }
                )
              : t('Choose when to get notified for changes in this document.'),
            testId('config-intro'),
          ),
          dom.maybe(errorMsg, (msg) => cssError(msg)),
          dom.create(AdminSectionItem, {
            id: 'notifications-doc-edits', name: t('Changes'),
            description: null,
            value: cssToggleSwitch(docEdits),
            disabled: accessDenied ? t('Only available to document collaborators') : null,
          }),
          dom.create(AdminSectionItem, {
            id: 'notifications-comments', name: t('Comments'),
            description: null,
            value: buildComments(comments),
            disabled: accessDenied ? t('Only available to document collaborators') : null,
          }),
        ];
      }),
    ]
  );
}

function buildComments(comments: Observable<CommentSetting>) {
  return cssSelect(comments, [
    {value: 'all', label: t('All comments')},
    {value: 'relevant', label: t('Replies and mentions')},
    {value: 'none', label: t('None')},
  ]);
}

const cssSelect = styled(select, `
  min-width: var(--admin-select-width);
`);
const cssToggleSwitch = styled(toggleSwitch, `
  margin: 0;
`);
const cssError = styled('div', `
  color: ${theme.errorText};
`);
const cssSaving = styled('span', `
  margin-left: 16px;
  font-size: ${vars.mediumFontSize};
  font-weight: normal;
  color: ${theme.lightText};
  opacity: 0;
  &-visible {
    opacity: 1;
    transition: opacity 0.25s ease-in-out 0.25s;
  }
`);
