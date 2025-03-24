import {ApiData, RecordsFormat, VirtualDoc, VirtualSection} from 'app/client/components/VirtualDoc';
import {hooks} from 'app/client/Hooks';
import {makeTestId} from 'app/client/lib/domUtils';
import {makeT} from 'app/client/lib/localization';
import {AppModel, getHomeUrl} from 'app/client/models/AppModel';
import {GRIST_TEST_ENABLE_ADMIN_CONTROLS} from 'app/client/models/features';
import {urlState} from 'app/client/models/gristUrlState';
import {
  buildAdminData as buildAdminDataCore,
  buildLeftPanel as buildLeftPanelCore
} from 'app/client/ui/AdminControlsCore';
import {AppHeader} from 'app/client/ui/AppHeader';
import * as css from 'app/client/ui/LeftPanelCommon';
import {PageSidePanel} from 'app/client/ui/PagePanels';
import {resizeFlexVHandle} from 'app/client/ui/resizeHandle';
import {basicButton, primaryButton} from 'app/client/ui2018/buttons';
import {isNarrowScreenObs, mediaNotSmall, mediaSmall, theme} from 'app/client/ui2018/cssVars';
import {IconName} from 'app/client/ui2018/IconList';
import {buildTabs, cssTab} from 'app/client/ui2018/tabs';
import {AdminControlsAPIImpl} from 'app/common/AdminControlsAPI';
import {AdminPanelPage, AdminPanelTab, IGristUrlState} from 'app/common/gristUrls';
import {not} from 'app/common/gutil';
import {bundleChanges, Computed, dom, MultiHolder, Observable, styled, UseCB} from 'grainjs';
import omit from 'lodash/omit';

const t = makeT('AdminPanel');
const testId = makeTestId('test-admin-controls-');

export function buildLeftPanel(owner: MultiHolder, appModel: AppModel): PageSidePanel {

  if (!GRIST_TEST_ENABLE_ADMIN_CONTROLS()) {
    return buildLeftPanelCore(owner, appModel);
  }

  // if we are not installation admin, also show what core would do.
  if (!appModel.isInstallAdmin()) {
    return buildLeftPanelCore(owner, appModel);
  }

  return {
    panelWidth: Observable.create(owner, 240),
    panelOpen: Observable.create(owner, true),
    content: buildContent(),
    header: dom.create(AppHeader, appModel),
  };

  function buildContent() {

    const entries: [string, IconName, IGristUrlState][] = [
      [t('Installation'), 'Home', {adminPanel: 'admin'}],
      [t('Users'), 'AddUser', {adminPanel: 'users'}],
      [t('Orgs'), 'Public', {adminPanel: 'orgs'}],
      [t('Workspaces'), 'Board', {adminPanel: 'workspaces'}],
      [t('Docs'), 'Page', {adminPanel: 'docs'}],
    ];

    const current = Computed.create(owner, use => {
      const state = use(urlState().state);
      return state.adminPanel;
    });

    return [
      css.cssLeftPanel(
        css.cssScrollPane(
          css.cssSectionHeader(css.cssSectionHeaderText(t("Admin controls"))),
          entries.map(([name, icon, state]) => {
            return css.cssPageEntry(
              css.cssPageEntry.cls('-selected', use => {
                return use(current) === state.adminPanel;
              }),
              css.cssPageLink(
                css.cssPageIcon(icon),
                css.cssLinkText(name),
                urlState().setLinkUrl(state),
              ),
              testId('page-' + state.adminPanel),
              testId('page'),
              testId('page-selected', use => use(current) === state.adminPanel),
            );
          })
        )
      ),
      css.leftPanelBasic(appModel, Observable.create(owner, true)),
    ];
  }
}

export function buildAdminData(owner: MultiHolder, appModel: AppModel) {

  if (!GRIST_TEST_ENABLE_ADMIN_CONTROLS()) {
    return buildAdminDataCore(owner, appModel);
  }

  if (!appModel.isInstallAdmin()) {
    return buildAdminDataCore(owner, appModel);
  }

  return dom.frag(
    dom.maybe(use => use(urlState().state).adminPanel === 'users', () => dom.create(userPage, appModel)),
    dom.maybe(use => use(urlState().state).adminPanel === 'orgs', () => dom.create(orgsPage, appModel)),
    dom.maybe(use => use(urlState().state).adminPanel === 'workspaces', () => dom.create(workspacePage, appModel)),
    dom.maybe(use => use(urlState().state).adminPanel === 'docs', () => dom.create(docsPage, appModel)),
  );
}

function userPage(owner: MultiHolder, appModel: AppModel) {
  // Create the api to fetch the data.
  const api = new AdminControlsAPIImpl(getHomeUrl(), {
    fetch: hooks.fetch,
  });

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
    columns: [
      {label: t('Name'), colId: 'name', ...Link('users')},
      {label: t('Email'), colId: 'email', type: 'Text'},
      {label: t('User Id'), colId: 'id', type: 'Int'},
      {label: t('First Login'), colId: 'firstLoginAtMs', ...Date},
      {label: t('Last Connection'), colId: 'lastConnectionAtMs', ...Date},
      {label: t('API Key'), colId: 'hasApiKey', type: 'Bool'},
      {label: t('Orgs'), colId: 'countOrgs', type: 'Int'},
      {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int'},
      {label: t('Docs'), colId: 'countDocs', type: 'Int'},
    ],
  });

  // 2. Users table for just one user (selected above), with user data.
  const selectedRow = selectedRowComputedNumber(owner);
  const filter = () => selectedRow.get() ? {userid: selectedRow.get()} : {};

  doc.addTable({
    name: 'Users',
    tableId: 'user',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch: selectedRow, // refresh when selected row changes.
    columns: [
      {label: t('Name'), colId: 'name', type: 'Text'},
      {label: t('Email'), colId: 'email', type: 'Text'},
      {label: t('First Login'), colId: 'firstLoginAtMs', ...Date},
      {label: t('Last Connection'), colId: 'lastConnectionAtMs', ...Date},
      {label: t('User Id'), colId: 'id', type: 'Int'},
      {label: t('API Key'), colId: 'hasApiKey', type: 'Bool'},
      {label: t('Orgs'), colId: 'countOrgs', type: 'Int'},
      {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int'},
      {label: t('Docs'), colId: 'countDocs', type: 'Int'},
    ]
  });

  // 3. Docs table for this user.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch: selectedRow, // refresh when selected row changes.
    columns: [
      {label: t('Access'), colId: 'access', type: 'Text'},
      {label: t('Name'), colId: 'name', ...Link('docs')},
      {label: t('URL Id'), colId: 'urlId', type: 'Text'},
      {label: t('Created By'), colId: 'createdBy', type: 'Int'},
      {label: t('Type'), colId: 'type', type: 'Text', ...defaultValue('Standard')},
      {label: t('Created At'), colId: 'createdAtMs', ...Date},
      {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
      {label: t('Workspace Id'), colId: 'workspaceId', type: 'Int'},
      {label: t('Workspace Name'), colId: 'workspaceName', ...Link('workspaces', 'workspaceId')},
      {label: t('Org Id'), colId: 'orgId', type: 'Int'},
      {label: t('Org Name'), colId: 'orgName', ...Link('orgs', 'orgId')},
      {label: t('Org Domain'), colId: 'orgDomain', type: 'Text'},
      {label: t('Is Personal'), colId: 'orgIsPersonal', type: 'Bool'},
      {label: t('Org Owner Id'), colId: 'orgOwnerId', type: 'Int'},
    ],
  });


  // 4. Workspaces table for this user.
  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspaces',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch: selectedRow, // refresh when selected row changes.
    columns: [
      {label: t('Access'), colId: 'access', type: 'Text'},
      {label: t('Name'), colId: 'name', ...Link('workspaces')},
      {label: t('Created At'), colId: 'createdAtMs', ...Date},
      {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
      {label: t('Org Id'), colId: 'orgId', type: 'Int'},
      {label: t('Org Name'), colId: 'orgName', ...Link('orgs', 'orgId')},
      {label: t('Org Domain'), colId: 'orgDomain', type: 'Text'},
      {label: t('Is Personal'), colId: 'orgIsPersonal', type: 'Bool'},
      {label: t('Org Owner Id'), colId: 'orgOwnerId', type: 'Int'},
      {label: t('Doc Count'), colId: 'countDocs', type: 'Int'},
      {label: t('User Count'), colId: 'countUsers', type: 'Int'},
      {label: t('Guest Count'), colId: 'countGuests', type: 'Int'},
      {label: t('Extra Doc User Count'), colId: 'countExtraDocUsers', type: 'Int'},
    ],
  });

  // 5. Orgs table for this user.
  doc.addTable({
    name: 'Orgs',
    tableId: 'orgs',
    data: new ApiData(() => api.adminGetOrgs(filter())),
    format: new RecordsFormat(),
    watch: selectedRow, // refresh when selected row changes.
    columns: [
      {label: t('Access'), colId: 'access', type: 'Text'},
      {label: t('Name'), colId: 'name', ...Link('orgs')},
      {label: t('Domain'), colId: 'domain', type: 'Text'},
      {label: t('Owner Id'), colId: 'ownerId', type: 'Int'},
      {label: t('Created At'), colId: 'createdAtMs', ...Date},
      {label: t('Is Personal'), colId: 'isPersonal', type: 'Bool'},
      {label: t('Workspace Count'), colId: 'countWorkspaces', type: 'Int'},
      {label: t('Doc Count'), colId: 'countDocs', type: 'Int'},
      {label: t('User Count'), colId: 'countUsers', type: 'Int'},
      {label: t('Guest Count'), colId: 'countGuests', type: 'Int'},
    ],
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

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Users'),
    tableId: mainTableId,
    listKey,
    detailsKey,
    tabs,
  });
}

function orgsPage(owner: MultiHolder, appModel: AppModel) {
  // Create the api to get the data from the backend.
  const api = new AdminControlsAPIImpl(getHomeUrl(), {
    fetch: hooks.fetch,
  });

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
    columns: [
      {label: t('Name'), type: 'Text', colId: 'name', ...Link('orgs')},
      {label: t('Domain'), type: 'Text', colId: 'domain'},
      {label: t('Org Id'), colId: 'id', type: 'Int'},
      {label: t('Is Personal'), type: 'Bool', colId: 'isPersonal'},
      {label: t('Owner Id'), type: 'Int', colId: 'ownerId'},
      {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int'},
      {label: t('Docs'), colId: 'countDocs', type: 'Int'},
      {label: t('Users'), colId: 'countUsers', type: 'Int'},
      {label: t('Guests'), colId: 'countGuests', type: 'Int'},
    ],
  });

  // 2. Single org table
  const selectedRow = selectedRowComputedNumber(owner);
  const filter = () => selectedRow.get() ? {orgid: selectedRow.get()} : {};

  doc.addTable({
    name: 'Orgs',
    tableId: 'org',
    data: new ApiData(() => api.adminGetOrgs(filter())),
    format: new RecordsFormat(),
    watch: selectedRow,
    columns: [
      {label: t('Name'), colId: 'name', type: 'Text'},
      {label: t('Domain'), colId: 'domain', type: 'Text'},
      {label: t('Org Id'), colId: 'id', type: 'Int'},
      {label: t('Is Personal'), colId: 'isPersonal', type: 'Bool'},
      {label: t('Owner Id'), colId: 'ownerId', type: 'Int'},
      {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int'},
      {label: t('Docs'), colId: 'countDocs', type: 'Int'},
      {label: t('Users'), colId: 'countUsers', type: 'Int'},
      {label: t('Guests'), colId: 'countGuests', type: 'Int'},
    ],
  });

  // 3. Docs table for this org.
  doc.addTable({
    name: 'Docs',
    tableId: 'docs',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch: selectedRow,

    columns: [
      {label: t('Name'), colId: 'name', ...Link('docs')},
      {label: t('URL Id'), colId: 'urlId', type: 'Text'},
      {label: t('Doc Id'), colId: 'id', type: 'Text'},
      {label: t('Created By'), colId: 'createdBy', type: 'Int'},
      {label: t('Type'), colId: 'type', type: 'Text', ...defaultValue('Standard')},
      {label: t('Created At'), ...Date, colId: 'createdAtMs'},
      {label: t('Updated At'), ...Date, colId: 'updatedAtMs'},
      {label: t('Workspace Id'), colId: 'workspaceId', type: 'Int'},
      {label: t('Workspace Name'), colId: 'workspaceName', ...Link('workspaces', 'workspaceId')},
      {label: t('User Count'), colId: 'countUsers', type: 'Int'},
      {label: t('Guest Count'), colId: 'countGuests', type: 'Int'},
    ],
  });

  // 4. Workspaces table for this org.
  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspaces',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch: selectedRow,
    columns: [
      {label: t('Name'), colId: 'name', ...Link('workspaces')},
      {label: t('Workspace Id'), colId: 'id', type: 'Int'},
      {label: t('Created At'), colId: 'createdAtMs', ...Date},
      {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
      {label: t('User Count'), colId: 'countUsers', type: 'Int'},
      {label: t('Guest Count'), colId: 'countGuests', type: 'Int'},
      {label: t('Extra Doc User Count'), colId: 'countExtraDocUsers', type: 'Int'},
      {label: t('Document Count'), colId: 'countDocs', type: 'Int'},
    ],
  });

  // 5. Users table for this org.
  doc.addTable({
    name: 'Users',
    tableId: 'users',
    data: new ApiData(() => api.adminGetUsers(filter())),
    format: new RecordsFormat(),
    watch: selectedRow,
    columns: [
      {label: t('Access'), colId: 'access', type: 'Text'},
      {label: t('Name'), colId: 'name', ...Link('users')},
      {label: t('Email'), colId: 'email', type: 'Text'},
      {label: t('User Id'), colId: 'id', type: 'Int'},
      {label: t('First Login'), colId: 'firstLoginAtMs', ...Date},
      {label: t('Last Connection'), colId: 'lastConnectionAtMs', ...Date},
      {label: t('API Key'), colId: 'hasApiKey', type: 'Bool'},
    ],
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

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Orgs'),
    tableId,
    listKey,
    detailsKey,
    tabs,
  });
}


function workspacePage(owner: MultiHolder, appModel: AppModel) {
  // Create the api to get the data from the backend.
  const api = new AdminControlsAPIImpl(getHomeUrl(), {
    fetch: hooks.fetch,
  });

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
    columns: [
      {label: t('Name'), colId: 'name', ...Link('workspaces')},
      {label: t('Workspace Id'), colId: 'id', type: 'Int'},
      {label: t('Created At'), colId: 'createdAtMs', ...Date},
      {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
      {label: t('Org Id'), colId: 'orgId', type: 'Int'},
      {label: t('Org Name'), colId: 'orgName', ...Link('orgs', 'orgId')},
      {label: t('Org Domain'), colId: 'orgDomain', type: 'Text'},
      {label: t('Is Personal'), colId: 'orgIsPersonal', type: 'Bool'},
      {label: t('Org Owner Id'), colId: 'orgOwnerId', ...Link('users', 'orgOwnerId')},
      {label: t('Doc Count'), colId: 'countDocs', type: 'Int'},
      {label: t('User Count'), colId: 'countUsers', type: 'Int'},
      {label: t('Guest Count'), colId: 'countGuests', type: 'Int'},
      {label: t('Extra Doc User Count'), colId: 'countExtraDocUsers', type: 'Int'},
    ],
  });

  // 2. Single workspace table
  const selectedRow = selectedRowComputedNumber(owner);
  const filter = () => selectedRow.get() ? {wsid: selectedRow.get()} : {};

  doc.addTable({
    name: 'Workspaces',
    tableId: 'workspace',
    data: new ApiData(() => api.adminGetWorkspaces(filter())),
    format: new RecordsFormat(),
    watch: selectedRow,
    columns: [
      {label: t('Name'), type: 'Text', colId: 'name'},
      {label: t('Workspace Id'), colId: 'id', type: 'Int'},
      {label: 'Created At', colId: 'createdAtMs', ...Date},
      {label: 'Updated At', colId: 'updatedAtMs', ...Date},
      {label: 'Org Id', type: 'Int', colId: 'orgId'},
      {label: 'Org Name', type: 'Text', colId: 'orgName'},
      {label: 'Org Domain', type: 'Text', colId: 'orgDomain'},
      {label: 'Is Personal', type: 'Bool', colId: 'orgIsPersonal'},
      {label: 'Org Owner Id', type: 'Int', colId: 'orgOwnerId'},
      {label: 'Doc Count', type: 'Int', colId: 'countDocs'},
      {label: 'User Count', type: 'Int', colId: 'countUsers'},
      {label: 'Guest Count', type: 'Int', colId: 'countGuests'},
      {label: 'Extra Doc User Count', type: 'Int', colId: 'countExtraDocUsers'},
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
    watch: selectedRow,
    columns: [
      {label: 'Name', type: 'Text', colId: 'name', ...Link('docs')},
      {label: 'URL Id', type: 'Text', colId: 'urlId'},
      {label: 'Doc Id', type: 'Text', colId: 'id'},
      {label: 'Is Pinned', type: 'Bool', colId: 'isPinned'},
      {label: 'Type', type: 'Text', colId: 'type', ...defaultValue('Standard')},

      {label: 'Created At', colId: 'createdAtMs', ...Date},
      {label: 'Created By', type: 'Int', colId: 'createdBy'},
      {label: 'Updated At', colId: 'updatedAtMs', ...Date},

      {label: 'User Count', type: 'Int', colId: 'countUsers'},
      {label: 'Guest Count', type: 'Int', colId: 'countGuests'},
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
    watch: selectedRow,
    columns: [
      {label: 'Access', type: 'Text', colId: 'access'},
      {label: 'Name', type: 'Text', colId: 'name', ...Link('users')},
      {label: 'Email', type: 'Text', colId: 'email'},
      {label: 'User Id', type: 'Int', colId: 'id'},
      {label: 'First Login', colId: 'firstLoginAtMs', ...Date},
      {label: 'Last Connection', colId: 'lastConnectionAtMs', ...Date},
      {label: 'API Key', type: 'Bool', colId: 'hasApiKey'},
      {
        label: 'WorkspaceId', colId: 'workspaceId',
        type: 'Ref:workspaces' as any,
        transform: () => selectedRow.get(),
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

  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Workspaces'),
    tableId,
    listKey,
    detailsKey,
    tabs,
  });
}

function docsPage(owner: MultiHolder, appModel: AppModel) {
  // Create the api to get the data from the backend.
  const api = new AdminControlsAPIImpl(getHomeUrl(), {
    fetch: hooks.fetch,
  });

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
    columns: [
      {label: 'Name', type: 'Text', colId: 'name', ...Link('docs')},
      {label: 'Url Id', type: 'Text', colId: 'urlId'},
      {label: 'Doc Id', type: 'Text', colId: 'id'},
      {label: 'Created At', colId: 'createdAtMs', ...Date},
      {label: 'Updated At', colId: 'updatedAtMs', ...Date},
      {label: 'Pinned', type: 'Bool', colId: 'isPinned'},
      {label: 'Created By', type: 'Int', colId: 'createdBy'},
      {label: 'Doc type', type: 'Text', colId: 'type', ...defaultValue('Standard')},

      {label: 'Workspace Id', type: 'Int', colId: 'workspaceId'},
      {label: 'Workspace Name', type: 'Text', colId: 'workspaceName', ...Link('workspaces')},

      {label: 'Org Id', type: 'Int', colId: 'orgId'},
      {label: 'Org Name', type: 'Text', colId: 'orgName', ...Link('orgs', 'orgId')},
      {label: 'Org Domain', type: 'Text', colId: 'orgDomain'},
      {label: 'Is Personal', type: 'Bool', colId: 'orgIsPersonal'},
      {label: 'Org Owner Id', type: 'Int', colId: 'orgOwnerId'},

      {label: 'Usage Rows', type: 'Int', colId: 'usageRows'},
      {label: 'Usage Data Bytes', type: 'Int', colId: 'usageDataBytes'},
      {label: 'Usage Attachment Bytes', type: 'Int', colId: 'usageAttachmentBytes'},

      {label: 'Guest Count', type: 'Int', colId: 'countGuests'},
      {label: 'User Count', type: 'Int', colId: 'countUsers'},
    ],
  });

  // When user clicks on a doc, it will put the row id in the url.
  const selectedRow = selectedRowComputedString(owner);
  const filter = () => selectedRow.get() ? {docid: selectedRow.get()!} : {};

  // 2. Table for the details tab.
  // Same table as above but only with one record, the user selected from the first table.
  doc.addTable({
    name: 'Docs',
    tableId: 'doc',
    data: new ApiData(() => api.adminGetDocs(filter())),
    format: new RecordsFormat(),
    watch: ifNotNew(owner, selectedRow),
    type: 'single',
    columns: [
      {label: 'Name', type: 'Text', colId: 'name'},
      {label: 'Url Id', type: 'Text', colId: 'urlId'},
      {label: 'Doc Id', type: 'Text', colId: 'id'},
      {label: 'Created At', colId: 'createdAtMs', ...Date},
      {label: 'Updated At', colId: 'updatedAtMs', ...Date},
      {label: 'Pinned', type: 'Bool', colId: 'isPinned'},
      {label: 'Created By', type: 'Int', colId: 'createdBy'},
      {label: 'Doc type', type: 'Text', colId: 'type', ...defaultValue('Standard')},

      {label: 'Workspace Id', type: 'Int', colId: 'workspaceId'},
      {label: 'Workspace Name', type: 'Text', colId: 'workspaceName', ...Link('workspaces')},

      {label: 'Org Id', type: 'Int', colId: 'orgId'},
      {label: 'Org Name', type: 'Text', colId: 'orgName', ...Link('orgs', 'orgId')},
      {label: 'Org Domain', type: 'Text', colId: 'orgDomain'},
      {label: 'Is Personal', type: 'Bool', colId: 'orgIsPersonal'},
      {label: 'Org Owner Id', type: 'Int', colId: 'orgOwnerId'},

      {label: 'Usage Rows', type: 'Int', colId: 'usageRows'},
      {label: 'Usage Data Bytes', type: 'Int', colId: 'usageDataBytes'},
      {label: 'Usage Attachment Bytes', type: 'Int', colId: 'usageAttachmentBytes'},

      {label: 'Guest Count', type: 'Int', colId: 'countGuests'},
      {label: 'User Count', type: 'Int', colId: 'countUsers'},

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
    watch: ifNotNew(owner, selectedRow),
    columns: [
      {label: 'Access', colId: 'access', type: 'Text'},
      {label: 'Name', colId: 'name', ...Link('users')},
      {label: 'Email', colId: 'email', type: 'Text'},
      {label: 'User Id', colId: 'id', type: 'Int'},
      {label: 'First Login', colId: 'firstLoginAtMs', ...Date},
      {label: 'Last Connection', colId: 'lastConnectionAtMs', ...Date},
      {label: 'API Key', colId: 'hasApiKey', type: 'Bool'},

      {
        label: 'DocId', colId: 'docId',
        type: 'Ref:docs' as any,
        transform: () => selectedRow.get()
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
  return buildPage(owner, {
    doc,
    selectedRow,
    header: t('Docs'),
    tableId,
    listKey,
    detailsKey,
    tabs,
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
}) {

  const {doc, selectedRow, header, tableId, listKey, detailsKey, tabs} = props;
  const hasDetails = detailsVisibleComputed(owner);
  const isMainFocused = Computed.create(owner, use => use(doc.viewModel.activeSectionId) === 'list' as any);
  doc.viewModel.activeSectionId(urlState().state.get().adminPanelTab ?? 'list' as any);

  return cssRows(

    buildHeader(header, hasDetails, val => {
      bundleChanges(() => {
        hasDetails.set(val);
        if (!val) {
          doc.viewModel.activeSectionId('list' as any);
        } else {
          doc.viewModel.activeSectionId(tabFromUrl() ?? 'details' as any);
        }
      });
    }),

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
          }
        }),
        testId('list'),
      ),

      dom.maybe(not(isNarrowScreenObs()), () =>
        cssDocumentResizeHandler({target: 'left'}, dom.show(hasDetails),)
      ),

      dom.maybeOwned(use => use(hasDetails), (domOwner) => {
        // What tab is selected.
        const tab = selectedTabComputed(domOwner, 'details');
        // Helper for checking which tab is active.
        const isSelected = (name: string) => (use: UseCB) => use(tab) === name;
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
            tab,
            cssTabsStyled.cls('-focus', isMainFocused),
          ),
          dom.forEach(tabs, tb => {
            return cssColumns(
              dom.show(isSelected(tb.id)),
              dom.create(VirtualSection, doc, {
                tableId: tb.tableId ?? tb.id,
                sectionId: tb.id,
                label: tb.label,
                type: tb.id === 'details' ? 'single' : 'record',
                hiddenColumns: [detailsKey],
                selectBy: {
                  sectionId: 'list',
                  colId: listKey,
                }
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

function selectedTabComputed(owner: MultiHolder, def: AdminPanelTab = 'details') {
  const computed = Computed.create<AdminPanelTab | undefined>(owner, use => {
    return use(urlState().state).adminPanelTab ?? def;
  });

  computed.onWrite(val => {
    urlState().pushUrl({
      adminPanelTab: val
    }, {replace: true}).catch(reportError);
  });

  return computed;
}


function selectedRowComputed<T>(owner: MultiHolder, cleaner: (val: any) => T) {
  const computed = Computed.create<T>(owner, use => {
    return cleaner(use(urlState().state).params?.state ?? 0);
  });

  computed.onWrite((val: any) => {
    val = val === 'new' ? 0 : val;
    urlState().pushUrl({
      params: {
        ...urlParams(),
        state: val ? String(val) : undefined,
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

function Link(page: AdminPanelPage, col = 'id') {
  return {
    transform: (value: any, rec: any) => {
      if (value === null || value === undefined) {
        return value;
      }
      const state = rec[col] ?? rec.id;
      const orgsUrl = urlState().makeUrl({
        adminPanel: page,
        params: {
          state,
          details: true,
        },
      });
      return `[${value}](${orgsUrl})`;
    },
    ...Markdown,
  };
}

const Date = {
  transform: (n: number) => n ? Math.round(n / 1000) : null, // Convert to seconds.
  type: 'Date' as any,
};


const Markdown = {
  type: 'Text',
  widgetOptions: {
    widget: 'Markdown',
  }
} as any;

function defaultValue<T>(value: T) {
  return {
    transform: (val?: T | null | undefined) => val ?? value,
  };
}


function buildHeader(
  name: string,
  hasDetails: Observable<boolean>,
  onSet?: (val: boolean) => void
) {
  return cssHeader(
    dom('h4', name, testId('page-header')),
    dom.maybe(hasDetails, () => basicButton(
      'Hide details',
      dom.on('click', () => onSet ? onSet(false) : hasDetails.set(false)),
      testId('details-button')
    )),
    dom.maybe(not(hasDetails), () => primaryButton(
      'Show details',
      dom.on('click', () => onSet ? onSet(true) : hasDetails.set(true)),
      testId('details-button')
    )),
  );
}

const cssHeader = styled('div', `
  margin-left: 12px;
  margin-right: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
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
      display: none;
      margin-top: -5px;
      margin-left: 4px;
    }
    .${cssDetails.className}-active & {
      display: flex;
    }
    .${cssTab.className} {
      padding-inline: clamp(1%, 4px, 16px);
    }
  }
  & .${cssTab.className} {
    border-bottom: 1px solid transparent;
  }
  & .${cssTab.className}-selected {
    /*
      This is trick to move the border bottom left 2px so that it is
      aligned with the green active border on the left.
    */
    border-bottom: 2px solid ${theme.controlFg};
    margin-bottom: -1px;
    margin-left: -2px;
    margin-right: 2px;
  }
  &-focus .${cssTab.className}-selected {
    margin-left: 0px;
    margin-right: 0px;
  }
`);

export const cssDocumentResizeHandler = styled(resizeFlexVHandle, `
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
