import {ApiData, RecordsFormat, VirtualDoc, VirtualSection} from 'app/client/components/VirtualDoc';
import {hooks} from 'app/client/Hooks';
import {makeTestId} from 'app/client/lib/domUtils';
import {loadUserManager} from 'app/client/lib/imports';
import {makeT} from 'app/client/lib/localization';
import {AppModel} from 'app/client/models/AppModel';
import {urlState} from 'app/client/models/gristUrlState';
import {areAdminControlsAvailable} from 'app/client/ui/AdminLeftPanel';
import {docColumns, orgColumns, userColumns, workspaceColumns} from 'app/client/ui/AdminControlsTables';
import {ResourceType} from 'app/client/models/UserManagerModel';
import {ICellContextMenu} from 'app/client/ui/CellContextMenu';
import {textInput} from 'app/client/ui/inputs';
import {resizeFlexVHandle} from 'app/client/ui/resizeHandle';
import {IRowContextMenu} from 'app/client/ui/RowContextMenu';
import {basicButton, bigBasicButton, bigPrimaryButton, primaryButton} from 'app/client/ui2018/buttons';
import {isNarrowScreenObs, mediaNotSmall, mediaSmall, theme} from 'app/client/ui2018/cssVars';
import {loadingSpinner} from 'app/client/ui2018/loaders';
import {buildMenuItems, select, selectMenu, selectOption, selectTitle} from 'app/client/ui2018/menus';
import {menuDivider, menuIcon, menuItem, menuItemLink, menuItemSubmenu} from 'app/client/ui2018/menus';
import {cssModalTitle, cssModalWidth, modal, spinnerModal} from 'app/client/ui2018/modals';
import {buildTabs, cssTab} from 'app/client/ui2018/tabs';
import {AdminControlsAPI, AdminControlsAPIImpl, IUserRecord} from 'app/common/AdminControlsAPI';
import {AdminSection} from 'app/client/ui/AdminPanelCss';
import {AdminPanelPage, AdminPanelTab, IGristUrlState} from 'app/common/gristUrls';
import {not} from 'app/common/gutil';
import {bundleChanges, Computed, Disposable, dom, DomContents, MultiHolder, Observable, styled, UseCB} from 'grainjs';
import {DomElementArg} from 'grainjs';
import omit from 'lodash/omit';

const t = makeT('AdminPanel');
const testId = makeTestId('test-admin-controls-');

export function buildAdminData(owner: MultiHolder, appModel: AppModel) {
  if (!areAdminControlsAvailable()) {
    return null;
  }

  if (!appModel.isInstallAdmin()) {
    // Reusing strings from AdminPanel.ts verbatim, so they wouldn't need separate translations.
    return dom.create(AdminSection, t('Administrator Panel Unavailable'), [
      dom('p', t(`You do not have access to the administrator panel.
Please log in as an administrator.`)),
      testId('admin-panel-error'),
    ]);
  }

  // Create the AdminControlsAPI object.
  const api = new AdminControlsAPIImpl(appModel.api.getBaseUrl(), {
    fetch: hooks.fetch,
  });

  const pageComponents: {[key in AdminPanelPage]?: typeof userPage} = {
    users: userPage,
    orgs: orgsPage,
    workspaces: workspacePage,
    docs: docsPage,
  };
  return dom.maybe(use => pageComponents[use(urlState().state).adminPanel!], (page) =>
    dom.create(page, appModel, api));
}

function userPage(owner: MultiHolder, appModel: AppModel, api: AdminControlsAPI) {
  // Create one in memory doc, to preserve filters during navigation.
  const doc = VirtualDoc.create(owner, appModel);

  // Create 5 external tables for 5 views we serve.
  // 1. Users table, unfiltered.
  // 2. Users table for just one user (selected above), with user data.
  // 3. Docs table for this user.
  // 4. Workspaces table for this user.
  // 5. Orgs table for this user.


  // 1. Users table, unfiltered.
  doc.addTable({
    name: 'Users',
    tableId: 'users',
    data: new ApiData(() => api.adminGetUsers({})),
    format: new RecordsFormat(),
    columns: userColumns({}),
  });

  // 2. Users table for just one user (selected above), with user data.
  const filter = () => selectedRow.get() ? {userid: selectedRow.get()} : {};
  const hasDetails = detailsVisibleComputed(owner);
  const selectedRow = selectedRowComputedNumber(owner);
  const watcher = Computed.create(owner, use => {
    if (!use(hasDetails)) {
      return 0;
    }
    return use(selectedRow);
  });


  doc.addTable({
    name: 'Users',
    tableId: 'user',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch: watcher, // refresh when selected row changes.
    columns: userColumns({detail: true}),
  });

  // 3. Docs table for this user.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch: watcher, // refresh when selected row changes.
    columns: docColumns({forUser: true}),
  });


  // 4. Workspaces table for this user.
  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspaces',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch: watcher, // refresh when selected row changes.
    columns: workspaceColumns({forUser: true}),
  });

  // 5. Orgs table for this user.
  doc.addTable({
    name: 'Orgs',
    tableId: 'orgs',
    data: new ApiData(() => api.adminGetOrgs(filter())),
    format: new RecordsFormat(),
    watch: watcher, // refresh when selected row changes.
    columns: orgColumns({forUser: true}),
  });

  const mainTableId = 'users';
  const listKey = 'userid';
  const detailsKey = 'docid';
  const tabs = [
    {id: 'details', tableId: 'user', label: t('Details')},
    {id: 'docs', label: t('Docs')},
    {id: 'workspaces', label: t('Workspaces')},
    {id: 'orgs', label: t('Orgs')},
  ];
  const isCurrent = Computed.create(owner, use => use(selectedRow) === appModel.currentValidUser?.id);


  async function deleteUser() {
    const userId = selectedRow.get();
    if (!userId) {
      return;
    }
    if (!appModel.currentValidUser) {
      throw new Error('No current user');
    }
    const allUsers = doc.docData.getTable('users')?.getRecords() || [];
    DeleteUserDialog.create(owner, {
      userId,
      api,
      currentUserId: appModel.currentValidUser.id,
      users: allUsers.map(r => ({id: r.id, email: String(r.email)})).sort((a, b) => a.email.localeCompare(b.email)),
      onDeleted: () => {
        // We need to manually move cursor. It won't be set automatically as the cursor doesn't detect
        // changes in the underlying data when a row is removed.

        // Find a main section that shows list and grab the cursor instance.
        const section = doc.viewModel.viewSections().all().find(s => s.id() === 'list' as any);
        const view = section?.viewInstance();
        const cursor = view?.cursor;
        if (cursor) {
          // Move to the first row we have.
          cursor.setCursorPos({rowIndex: 0});
        }
        // And force table reload.
        doc.refreshTableData('users').catch(reportError);
      }
    });
  }

  // Build the menu for the actions, it will be used both for row and context menu.
  const actionMenu = (items: Element[], options: {numRows: number}) => [
    ...buildMenuItems([
      {
        label: t('Actions'),
        submenu: [
          {
            label: t('Remove user'),
            icon: 'Remove',
            action: deleteUser,
            disabled: isCurrent.get() || options.numRows > 1,
          }
        ]
      },
      {
        type: 'separator'
      }
    ]),
    ...items,
  ];

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Users'),
    tableId: mainTableId,
    listKey,
    detailsKey,
    tabs,
    contextMenu: actionMenu,
    rowMenu: actionMenu,
    buttons: [
      actionButton(hasDetails, () => [
        selectOption(
          deleteUser,
          t("Remove user"),
          "Remove",
          dom.cls('disabled', isCurrent),
          testId('remove-action')
        ),
      ]),
    ]
  });
}

function orgsPage(owner: MultiHolder, appModel: AppModel, api: AdminControlsAPI) {
  // Create one in memory doc, to preserve filters during navigation.
  const doc = VirtualDoc.create(owner, appModel);

  // Create 5 external tables for 5 views we serve.
  // 1. Orgs table, unfiltered.
  // 2. Single org table
  // 3. Docs table for this org.
  // 4. Workspaces table for this org.
  // 5. Users table for this org.

  // 1. Orgs table, unfiltered.
  doc.addTable({
    name: 'Orgs',
    tableId: 'orgs',
    data: new ApiData(() => api.adminGetOrgs({})),
    format: new RecordsFormat(),
    columns: orgColumns({}),
  });

  // 2. Single org table
  const selectedRow = selectedRowComputedNumber(owner);
  const filter = () => selectedRow.get() ? {orgid: selectedRow.get()} : {};
  const details = detailsVisibleComputed(owner);
  const watch = Computed.create(owner, use => use(details) ? use(selectedRow) : 0);

  doc.addTable({
    name: 'Orgs',
    tableId: 'org',
    data: new ApiData(() => api.adminGetOrgs(filter())),
    format: new RecordsFormat(),
    watch,
    columns: orgColumns({detail: true}),
  });

  // 3. Docs table for this org.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch,
    columns: docColumns({forOrg: true}),
  });

  // 4. Workspaces table for this org.
  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspaces',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch,
    columns: workspaceColumns({forOrg: true}),
  });

  // 5. Users table for this org.
  doc.addTable({
    name: 'Users',
    tableId: 'users',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch,
    columns: userColumns({filtered: true}),
  });

  const tableId = 'orgs';
  const listKey = 'orgid';
  const detailsKey = 'docid';
  const tabs = [
    {id: 'details', tableId: 'org', label: t('Details')},
    {id: 'docs', label: t('Docs')},
    {id: 'workspaces', label: t('Workspaces')},
    {id: 'users', label: t('Users')},
  ];

  // Figure out what the domain of personal orgs is.
  const personalOrg = appModel.topAppModel.orgs.get().find(o => Boolean(o.owner))?.domain || undefined;

  function getResourceUrlState(rowId: number) {
    const tableData = doc.docData.getTable('orgs')!;
    const org = (tableData.getValue(rowId, 'domain') || personalOrg) as string;
    return {org};
  }

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Orgs'),
    tableId,
    listKey,
    detailsKey,
    tabs,
    ...addResourceActions(details, () => [
      openResourceAction(getResourceUrlState(selectedRow.get()), t("Open organization")),
      openManageUsersAction(() => manageUsers(appModel, api, 'organization', selectedRow.get())),
    ]),
  });
}

function workspacePage(owner: MultiHolder, appModel: AppModel, api: AdminControlsAPI) {
  // Create one in memory doc, to preserve filters during navigation.
  const doc = VirtualDoc.create(owner, appModel);

  // Create 4 external tables for 5 views we serve.
  // 1. Workspace table, unfiltered.
  // 2. Single workspace table
  // 3. Docs table for this org.
  // 4. Users table for this org.

  // 1. Workspaces table, unfiltered.

  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspaces',
    data: new ApiData(() => api.adminGetWorkspaces({})),
    format: new RecordsFormat(),
    columns: workspaceColumns({}),
  });

  // 2. Single workspace table
  const selectedRow = selectedRowComputedNumber(owner);
  const filter = () => selectedRow.get() ? {wsid: selectedRow.get()} : {};
  const details = detailsVisibleComputed(owner);
  const watch = Computed.create(owner, use => use(details) ? use(selectedRow) : 0);

  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspace',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch,
    columns: [...workspaceColumns({detail: true}),
      {
        label: 'WorkspaceId', colId: 'workspaceId',
        type: 'Ref:workspaces' as any,
        transform: () => selectedRow.get(),
      },
    ]
  });

  // 3. Docs table for this workspace.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch,
    columns: [
      ...docColumns({forWs: true}),
      {
        label: 'WorkspaceId', colId: 'workspaceId',
        type: 'Ref:workspaces' as any,
        transform: () => selectedRow.get(),
      },
    ],
  });

  // 4. Users table for this workspace.
  doc.addTable({
    name: 'Users',
    tableId: 'users',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch,
    columns: [...userColumns({filtered: true}),
      {
        label: 'WorkspaceId', colId: 'workspaceId',
        type: 'Ref:workspaces' as any,
        transform: () => selectedRow.get(),
        width: 100,
      },
    ],
  });

  const tableId = 'workspaces';
  const listKey = 'id';
  const detailsKey = 'workspaceId';
  const tabs = [
    {id: 'details', tableId: 'workspace', label: t('Details')},
    {id: 'docs', label: t('Docs')},
    {id: 'users', label: t('Users')},
  ];

  function getResourceUrlState(rowId: number) {
    const tableData = doc.docData.getTable('workspaces')!;
    const org = tableData.getValue(rowId, 'orgDomain') as string;
    return {org, ws: rowId};
  }

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Workspaces'),
    tableId,
    listKey,
    detailsKey,
    tabs,
    ...addResourceActions(details, () => [
      openResourceAction(getResourceUrlState(selectedRow.get()), t("Open workspace")),
      openManageUsersAction(() => manageUsers(appModel, api, 'workspace', selectedRow.get())),
    ]),
  });
}

function docsPage(owner: MultiHolder, appModel: AppModel, api: AdminControlsAPI) {
  // Create one in memory doc, to preserve filters during navigation.
  const doc = VirtualDoc.create(owner, appModel);

  // Add 3 tables.

  // 1. All docs table.
  // Unfiltered table of all docs in the system.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs({})),
    format: new RecordsFormat(),
    columns: docColumns({}),
  });

  // When user clicks on a doc, it will put the row id in the url.
  const selectedRow = selectedRowComputedString(owner);
  const filter = () => selectedRow.get() ? {docid: selectedRow.get()!} : {};
  const details = detailsVisibleComputed(owner);
  const watch = Computed.create(owner, use => use(details) ? use(selectedRow) : 0);

  // 2. Table for the details tab.
  // Same table as above but only with one record, the user selected from the first table.
  doc.addTable({
    name: 'Docs',
    tableId: 'doc',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch: ifNotNew(owner, watch),
    type: 'single',
    columns: [
      ...docColumns({detail: true}),
      {
        label: 'DocId', colId: 'docId',
        type: 'Ref:docs' as any,
        transform: () => selectedRow.get()
      }
    ],
  });

  // 3. Table for the users, filtered by the doc id.
  doc.addTable({
    name: 'Users',
    tableId: 'users',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch: ifNotNew(owner, watch),
    columns: [...userColumns({filtered: true}),
      {
        label: 'DocId', colId: 'docId',
        type: 'Ref:docs' as any,
        transform: () => selectedRow.get(),
      }
    ],
  });

  const tableId = 'docs';
  const listKey = 'id';
  const detailsKey = 'docId';
  const tabs = [
    {id: 'details', tableId: 'doc', label: t('Details')},
    {id: 'users', label: t('Users')},
  ];

  function getResourceUrlState(rowId: string) {
    const tableData = doc.docData.getTable('docs')!;
    const org = tableData.getValue(rowId as any, 'orgDomain') as string;
    return {org, doc: rowId};
  }

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Docs'),
    tableId,
    listKey,
    detailsKey,
    tabs,
    ...addResourceActions(details, () => [
      openResourceAction(getResourceUrlState(selectedRow.get()), t("Open document")),
      openManageUsersAction(() => manageUsers(appModel, api, 'document', selectedRow.get())),
    ]),
  });
}

function actionButton(hasDetails: Observable<boolean>, items: () => DomElementArg[]) {
  return selectMenu(selectTitle(t("Actions")), items,
    dom.show(hasDetails),
    testId('actions')
  );
}

function openResourceAction(resourceUrlState: IGristUrlState, label: string) {
  return menuItemLink(
    {href: urlState().makeUrl(resourceUrlState), target: '_blank'},
    menuIcon("FieldLink"),
    label,
  );
}

function openManageUsersAction(open: () => Promise<void>) {
  return menuItem(open, menuIcon("Share"), t("View sharing"));
}

function addResourceActions(hasDetails: Observable<boolean>, actionItems: () => DomElementArg[]) {
  const actionMenu = (items: Element[], options: {numRows: number}) => [
    menuItemSubmenu(actionItems, {}, t("Actions")),
    menuDivider(),
    ...items,
  ];
  return {
    contextMenu: actionMenu,
    rowMenu: actionMenu,
    buttons: actionButton(hasDetails, actionItems),
  };
}

async function manageUsers(
  appModel: AppModel, adminApi: AdminControlsAPI, resourceType: ResourceType, resourceId: string|number
) {
  // Translate ResourceType to AdminControls param name.
  const paramName = {organization: 'orgid', workspace: 'wsid', document: 'docid'}[resourceType];
  (await loadUserManager()).showUserManagerModal(appModel.api, {
    permissionData: adminApi.adminGetResourceAccess({[paramName]: resourceId}),
    activeUser: appModel.currentUser,
    resourceType,
    resourceId,
    isReadonly: true,
  });
}

function buildPage(owner: MultiHolder, props: {
  doc: VirtualDoc,
  selectedRow: Observable<number | string>,
  header: string,
  tableId: string,
  listKey: string,
  detailsKey: string,
  tabs: {id: string, tableId?: string, label: string}[],
  contextMenu?: (items: Element[], options: ICellContextMenu) => Element[],
  rowMenu?: (items: Element[], options: IRowContextMenu) => Element[],
  buttons?: DomContents,
}) {

  const {doc, selectedRow, header, tableId, listKey, detailsKey, tabs} = props;
  const hasDetails = detailsVisibleComputed(owner);
  const isMainFocused = Computed.create(owner, use => use(doc.viewModel.activeSectionId) === 'list' as any);
  doc.viewModel.activeSectionId(urlState().state.get().adminPanelTab ?? 'list' as any);
  const toggleDetails = (val: boolean) => {
    bundleChanges(() => {
      hasDetails.set(val);
      if (!val) {
        doc.viewModel.activeSectionId('list' as any);
      } else {
        doc.viewModel.activeSectionId(tabFromUrl() ?? 'details' as any);
      }
    });
  };

  return cssRows(
    buildHeader(header, [
      props.buttons,
      showDetailsButton(hasDetails, toggleDetails),
      hideDetailsButton(hasDetails, toggleDetails),
    ]),
    cssBody(
      cssList(
        cssList.cls('-has-details', hasDetails),
        cssList.cls('-active', isMainFocused),
        dom.create(VirtualSection, doc, {
          tableId,
          sectionId: 'list',
          selectedRow,
          onCard: () => {
            hasDetails.set(true);
          },
          cellMenu: props.contextMenu,
          rowMenu: props.rowMenu,
          disableAddRemove: true,
        }),
        testId('list'),
      ),

      dom.maybe(not(isNarrowScreenObs()), () =>
        cssDocumentResizeHandler({target: 'left'}, dom.show(hasDetails),)
      ),

      dom.maybeOwned(use => use(hasDetails), (domOwner) => {
        // What tab is selected.
        const tab = selectedTabComputed(domOwner);
        const tabDef = Computed.create(domOwner, use => use(tab) ?? 'details');
        // Helper for checking which tab is active.
        const isSelected = (name: string) => (use: UseCB) => use(tabDef) === name;
        const changeTab = (name: string) => () => {
          tab.set(name as any);
          doc.viewModel.activeSectionId(name as any);
        };
        domOwner.autoDispose(tab.addListener(
          name => doc.viewModel.activeSectionId(name ?? 'list' as any)
        ));

        return cssDetails(
          cssDetails.cls('-has-details', hasDetails),
          cssDetails.cls('-active', use => !use(isMainFocused)),
          cssTabsStyled(
            tabs.map(tb => ({
              id: tb.id,
              label: tb.label,
              onClick: changeTab(tb.id),
            })),
            tabDef,
          ),
          dom.forEach(tabs, tb => {
            // Since grid in details tab is hidden, the scroll can't measure it's height.
            // So we need to set it manually, by passing the isVisible computed.
            const isVisible = Computed.create(null, isSelected(tb.id));
            return cssColumns(
              dom.show(isVisible),
              dom.autoDispose(isVisible),
              dom.create(VirtualSection, doc, {
                tableId: tb.tableId ?? tb.id,
                sectionId: tb.id,
                label: tb.label,
                type: tb.id === 'details' ? 'single' : 'record',
                hiddenColumns: [detailsKey],
                isVisible,
                selectBy: {
                  sectionId: 'list',
                  colId: listKey,
                },
                disableAddRemove: true,
              }),
            );
          }),
        );
      }),
    )
  );
}

function urlParams() {
  return urlState().state.get().params ?? {};
}

function detailsVisibleComputed(owner: MultiHolder) {
  const hasDetails = Computed.create(owner, use => {
    return use(urlState().state).params?.details ?? false;
  });
  hasDetails.onWrite(val => {
    urlState().pushUrl({
      params: {
        ...omit(urlParams(), 'details'),
        ...(val ? {details: true} : {}),
      },
      adminPanelTab: undefined,
    }, {replace: true}).catch(reportError);
  });
  return hasDetails;
}

function tabFromUrl() {
  return urlState().state.get().adminPanelTab;
}

function selectedTabComputed(owner: MultiHolder) {
  const computed = Computed.create<AdminPanelTab | undefined>(owner, use => {
    return use(urlState().state).adminPanelTab;
  });

  computed.onWrite(val => {
    urlState().pushUrl({
      hash: undefined,
      adminPanelTab: val
    }, {replace: true}).catch(reportError);
  });

  return computed;
}


function selectedRowComputed<T>(owner: MultiHolder, cleaner: (val?: string) => T) {
  const computed = Computed.create<T>(owner, use => {
    return cleaner(use(urlState().state).params?.state);
  });

  computed.onWrite((val: T | undefined) => {
    urlState().pushUrl({
      params: {
        ...urlParams(),
        state: val && val !== 'new' ? String(val) : undefined,
      }
    }, {replace: true}).catch(reportError);
  });

  return computed;
}

// The same computed, but will always produce a number
function selectedRowComputedNumber(owner: MultiHolder) {
  return selectedRowComputed(owner, val => val && !isNaN(Number(val)) ? Number(val) : 0);
}

// Same but for string.
function selectedRowComputedString(owner: MultiHolder) {
  return selectedRowComputed(owner, val => val ? String(val) : '');
}

/** Creates an computed observable that syncs with the  */
function ifNotNew<T = any>(owner: MultiHolder, value: Computed<T>) {
  const initial = String(value.get()) === 'new' ? undefined : value.get();
  const inner = Observable.create<any>(owner, initial);
  owner.autoDispose(value.addListener(newValue => {
    if (String(newValue) !== 'new' && initial !== newValue) {
      inner.set(newValue);
    }
  }));
  return inner;
}

/**
 * Builds header of one of the admin page.
 * @param name  Name of the page.
 * @param buttons Additional buttons to show in the header.
 */
function buildHeader(
  name: string,
  buttons?: DomContents,
) {
  return cssHeader(
    dom('h4', name, testId('page-header')),
    buttons ? cssButtons(
      buttons
    ) : null,
  );
}

/**
 * Shows dialog for deleting user.
 */
class DeleteUserDialog extends Disposable {
  private _userList = Observable.create(this, []) as Observable<{email: string, id: number}[]>;
  private _userToDelete: Observable<IUserRecord | null> = Observable.create(this, null);
  private _email = Observable.create(this, '');
  private _otherUser = Observable.create(this, null) as Observable<number | null>;
  private _emailValid = Computed.create(this, use => {
    return use(this._userToDelete) && use(this._email).trim() === use(this._userToDelete)!.fields.email;
  });
  private _canDelete = Computed.create(this, use => {
    return Boolean(use(this._userToDelete) && use(this._email) && use(this._otherUser)) && use(this._emailValid);
  });
  private _pending = Observable.create(this, false);
  private _loaded = Observable.create(this, false);
  private _belongings = Observable.create(this, {docs: 0, orgs: 0, workspaces: 0, personalDocs: 0});
  private _userId: number;
  private _currentUserId: number;
  private _onDeleted?: () => void;
  private _api: AdminControlsAPI;

  constructor(props: {
    userId: number,
    currentUserId: number,
    users: {email: string, id: number}[],
    api: AdminControlsAPI,
    onDeleted?: () => void,
  }) {
    super();

    this._userId = props.userId;
    this._currentUserId = props.currentUserId;
    this._onDeleted = props.onDeleted;
    this._api = props.api;

    if (this._userId === this._currentUserId) {
      throw new Error('Cannot delete self');
    }

    this._userList.set(props.users);

    this._init().catch(reportError);
    this.showPopup();
  }

  public showPopup() {
    modal((ctl, owner) => {

      // If we are disposed, make sure to close the dialog.
      this.onDispose(() => {
        // but only if it wasn't closed already.
        if (owner.isDisposed()) {
          return;
        }
        ctl.close();
      });

      return [
        testId('remove-dialog'),
        cssModalWidth('fixed-wide'),
        cssModalTitle(t("Delete account")),
        spinner(
          testId('spinner'),
          loadingSpinner(),
          dom.show(this._pending),
        ),
        dom.maybe(this._loaded, () => [
          cssText(t(`Are you sure you want to delete {{email}} account? \
This action is permanent and cannot be undone.`,
            {email: dom('b', this._userToDelete.get()!.fields.email)}),
          ),
          cssInput(this._email,
            {
              placeholder: t("To proceed, please type users`s email address"),
              required: 'true',
            },
            (el) => {
              setTimeout(() => el.focus(), 10);
            },
            testId('email'),
            dom.style('margin-top', '16px'),
          ),
          // If this user has some belongings, show warnings.
          dom.domComputed(this._belongings, belongings => {
            const warnings: DomContents[] = [];
            if (belongings.personalDocs) {
              warnings.push(
                cssText(t("Personal org and {{numDocs}} personal documents will be permanently removed.",
                  {numDocs: dom('b', String(belongings.personalDocs))})),
              );
            }
            const hasTeamMaterials = (belongings.docs > 0 || belongings.orgs > 0 || belongings.workspaces > 0);
            if (hasTeamMaterials) {
              // If there are team materials, show the ui for transferring them.
              const users = this._userList.get().filter(notUser(this._userId)).map(toMenuItem);
              warnings.push(
                cssText(
                  t(`This user is an owner of some material in team sites: \
{{numDocs}} docs, {{numOrgs}} orgs, {{numWorkspaces}} workspaces. \
Please select another user to transfer them to.`,
                    {
                      numDocs: dom('b', String(belongings.docs)),
                      numOrgs: dom('b', String(belongings.orgs)),
                      numWorkspaces: dom('b', String(belongings.workspaces)),
                    }),
                ),
                dom.update(
                  select(this._otherUser, users),
                  testId('other-user-select'),
                ),
              );
            }
            return warnings.length > 0 ? cssWarning(warnings, testId('warning')) : null;
          }),
          cssButtonsLine(
            bigBasicButton(
              t('Yes, delete account'),
              dom.prop('disabled', use => use(this._pending) || !use(this._canDelete)),
              testId('confirm'),
              dom.on('click', async () => {
                ctl.close();
                await this._removeAccount();
              })
            ),
            bigPrimaryButton(t('Cancel'),
              testId('cancel'),
              dom.prop('disabled', this._pending),
              dom.on('click', () => ctl.close()),
            )
          )
        ]),
      ];
    });
  }

  // If we are disposed we will close the dialog also, but we can be put in multiple holders
  // so don't dispose the dialog twice.
  public dispose() {
    if (this.isDisposed()) {
      return;
    }
    this.dispose();
  }

  private async _init() {
    this._email.set('');


    // First load the user that we want to delete.
    this._userToDelete.set(await this._api.adminGetUser(this._userId));

    // Fill out belongings of this user (fetch other things user is owner of).
    const allDocs = await this._api.adminGetDocs({userid: this._userId});
    const personalDocs = allDocs.records.filter(r => r.fields.orgOwnerId === this._userId).length;
    const docs = allDocs.records.filter(r => r.fields.access === 'owners' && !r.fields.orgIsPersonal).length;
    const orgs = (await this._api.adminGetOrgs({userid: this._userId})).records.filter(
      r => r.fields.access === 'owners' && !r.fields.isPersonal
    ).length;
    const workspaces = (await this._api.adminGetWorkspaces({userid: this._userId})).records.filter(
      r => r.fields.access === 'owners' && !r.fields.orgIsPersonal
    ).length;
    const belongings = {docs, orgs, workspaces, personalDocs};
    this._belongings.set(belongings);
    // We will transfer all those belongings to the new user.
    this._otherUser.set(this._currentUserId);

    this._loaded.set(true);
  }


  private async _removeAccount() {
    // Check if the values are filled in.
    const userRecord = this._userToDelete.get();
    const email = this._email.get().trim();
    const otherUser = this._otherUser.get()!;
    if (!userRecord || !email || !otherUser) {
      throw new Error('Invalid state');
    }

    await spinnerModal(t("Deleting account"), this._api.adminDeleteUser(
      userRecord.id,
      email,
      otherUser,
    ));

    this._onDeleted?.();
  }
}

function hideDetailsButton(hasDetails: Observable<boolean>, onClick?: (on: boolean) => void) {
  return cssBasicButton(
    t("Hide details"),
    dom.on('click', () => onClick ? onClick(false) : hasDetails.set(false)),
    testId('hide-details-button'),
    dom.show(hasDetails),
  );
}

function showDetailsButton(hasDetails: Observable<boolean>, onClick?: (on: boolean) => void) {
  return cssPrimaryButton(
    t("Show details"),
    dom.on('click', () => onClick ? onClick(true) : hasDetails.set(true)),
    testId('show-details-button'),
    dom.show(not(hasDetails)),
  );
}

function toMenuItem(u: {email: string, id: number}) {
  return {
    label: u.email,
    value: u.id,
  };
}

function notUser(userId: number) {
  return (user: {id: number}) => user.id !== userId;
}

const cssPrimaryButton = styled(primaryButton, `
  flex-shrink: 0;
`);

const cssBasicButton = styled(basicButton, `
  flex-shrink: 0;
`);

const cssHeader = styled('div', `
  margin-left: 12px;
  margin-right: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
`);

const cssButtons = styled('div', `
  display: flex;
  gap: 8px;
`);

const cssRows = styled('div', `
  display: flex;
  flex-direction: column;
  flex: 1;
`);

const cssColumns = styled('div', `
  display: flex;
  flex: 1;
`);

const cssBody = styled(cssColumns, `
  @media ${mediaSmall} {
    & {
      padding: 0px 12px;
    }
  }
`);

const cssWarning = styled('div', `
  border-radius: 4px;
  padding: 16px;
  margin-top: 16px;
  border: 1px solid ${theme.toastErrorBg};
`);

const cssList = styled('div._cssList', `
  display: flex;
  @media ${mediaNotSmall} {
    & {
      width: 100%;
    }
    &-has-details {
      width: 300px;
    }
  }
  @media ${mediaSmall} {
    & {
      flex-basis: 53px;
      flex-grow: 0;
      flex-shrink: 0;
      transition: flex .4s cubic-bezier(0.4, 0, 0.2, 1), opacity .8s;
    }
    &-active {
      flex: 1;
    }
  }
`);

const cssDetails = styled('div._cssDetails', `
  display: flex;
  position: relative;
  height: 100%;
  @media ${mediaNotSmall} {
    &-has-details {
      flex: 1;
    }
  }
  @media ${mediaSmall} {
    & {
      flex-basis: 53px;
      flex-grow: 0;
      flex-shrink: 0;
      transition: flex .4s cubic-bezier(0.4, 0, 0.2, 1), opacity .8s;
    }
    &-active {
      flex: 1;
    }
  }
`);

const cssTabsStyled = styled(buildTabs, `
  position: absolute;
  background: ${theme.mainPanelBg};
  z-index: 100;
  margin-top: 3px;
  margin-left: 12px;
  flex: none;
  max-width: calc(100% - 40px);

  @media ${mediaSmall} {
    & {
      margin-top: -5px;
      margin-left: 4px;
    }
    .${cssTab.className} {
      padding-inline: clamp(8px, 2vw, 16px);
    }
  }
  & .${cssTab.className} {
    padding-bottom: 2px;
  }
`);

const cssInput = styled(textInput, `
  height: 42px;
  line-height: 16px;
  padding: 13px;
  border-radius: 3px;
`);

const cssDocumentResizeHandler = styled(resizeFlexVHandle, `
  /* two highlighted 1px lines are placed in the middle, normal and highlighted one */
  &::before, &::after {
    content: "";
    position: absolute;
    height: 100%;
    width: 1px;
    border-left: 1px dashed transparent;
    left: 3px;
    background: transparent;
  }
  /* the highlighted line is shown on hover with opacity transition */
  &::after {
    border-color: #a9a9a9;
    opacity: 0;
    transition: opacity 0.2s;
  }
  &:hover::after {
    opacity: 1;
    transition: opacity 0.2s;
  }
  /* the highlighted line is also always shown while dragging */
  &-dragging::after {
    opacity: 1;
    transition: none !important;
  }
`);

const cssText = styled('p', `
  margin-bottom: 16px;
  &:last-child {
    margin-bottom: 0;
  }
`);

const cssButtonsLine = styled('div', `
  display: flex;
  gap: 8px;
  margin-top: 32px;
`);

const spinner = styled('div', `
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
  min-width: 200px;
`);
