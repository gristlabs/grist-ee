import {ColumnSpec} from 'app/client/components/VirtualDoc';
import {urlState} from 'app/client/models/gristUrlState';
import {AdminPanelPage} from 'app/common/gristUrls';
import {makeT} from 'app/client/lib/localization';

const t = makeT('AdminPanel');

export function userColumns(opts: {filtered?: boolean, detail?: boolean}): ColumnSpec<string>[] {
  return [
    ...(opts.filtered ? [{label: t('Access'), colId: 'access', type: 'Text', width: 80}] : []),
    {label: t('Name'), colId: 'name', type: 'Text', width: 200, ...(opts.detail ? {} : Link('users'))},
    {label: t('Email'), colId: 'email', type: 'Text', width: 220},
    {label: t('User Id'), colId: 'id', type: 'Int', width: 80},
    {label: t('First Login'), colId: 'firstLoginAtMs', ...Date},
    {label: t('Last Connection'), colId: 'lastConnectionAtMs', ...Date, width: 150},
    {label: t('API Key'), colId: 'hasApiKey', type: 'Bool', width: 80},
    ...(opts.filtered ? [] : [
      {label: t('Orgs'), colId: 'countOrgs', type: 'Int', width: 80},
      {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int', width: 80},
      {label: t('Docs'), colId: 'countDocs', type: 'Int', width: 80},
    ]),
  ];
}

export function orgColumns(opts: {forUser?: boolean, detail?: boolean}): ColumnSpec<string>[] {
  return [
    ...(opts.forUser ? [{label: t('Access'), colId: 'access', type: 'Text', width: 80}] : []),
    {label: t('Name'), colId: 'name', type: 'Text', width: 200, ...(opts.detail ? {} : Link('orgs'))},
    {label: t('Org Id'), colId: 'id', type: 'Int', width: 80},
    {label: t('Domain'), colId: 'domain', type: 'Text', width: 150},
    {label: t('Is Personal'), colId: 'isPersonal', type: 'Bool', width: 80},
    {label: t('Owner Id'), colId: 'ownerId', type: 'Int', width: 80},
    {label: t('Created At'), colId: 'createdAtMs', ...Date},
    {label: t('Workspaces'), colId: 'countWorkspaces', type: 'Int', width: 80},
    {label: t('Docs'), colId: 'countDocs', type: 'Int', width: 80},
    {label: t('Users'), colId: 'countUsers', type: 'Int', width: 80},
    {label: t('Guests'), colId: 'countGuests', type: 'Int', width: 80},
  ];
}

function parentOrgColumns(): ColumnSpec<string>[] {
  return [
    {label: t('Org Id'), colId: 'orgId', type: 'Int', width: 80},
    {label: t('Org Name'), colId: 'orgName', width: 200, ...Link('orgs', 'orgId')},
    {label: t('Org Domain'), colId: 'orgDomain', type: 'Text', width: 150},
    {label: t('Is Personal'), colId: 'orgIsPersonal', type: 'Bool', width: 80},
    {label: t('Org Owner Id'), colId: 'orgOwnerId', type: 'Int', width: 80},
  ];
}

export function workspaceColumns(opts: {forUser?: boolean, forOrg?: boolean, detail?: boolean}): ColumnSpec<string>[] {
  return [
    ...(opts.forUser ? [{label: t('Access'), colId: 'access', type: 'Text', width: 80}] : []),
    {label: t('Name'), colId: 'name', type: 'Text', width: 200, ...(opts.detail ? {} : Link('workspaces'))},
    {label: t('Workspace Id'), colId: 'id', type: 'Int'},
    {label: t('Created At'), colId: 'createdAtMs', ...Date},
    {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
    ...(opts.forOrg ? [] : parentOrgColumns()),
    {label: t('Docs'), colId: 'countDocs', type: 'Int', width: 80},
    {label: t('Users'), colId: 'countUsers', type: 'Int', width: 80},
    {label: t('Guests'), colId: 'countGuests', type: 'Int', width: 80},
    {label: t('Extra Doc Users'), colId: 'countExtraDocUsers', type: 'Int', width: 160},
  ];
}

export function docColumns(
  opts: {forUser?: boolean, forOrg?: boolean, forWs?: boolean, detail?: boolean}
): ColumnSpec<string>[] {
  return [
    ...(opts.forUser ? [{label: t('Access'), colId: 'access', type: 'Text', width: 80}] : []),
    {label: t('Name'), colId: 'name', type: 'Text', width: 200, ...(opts.detail ? {} : Link('docs'))},
    {label: t('Doc Id'), colId: 'id', type: 'Text', width: 80},

    {label: t('Users'), colId: 'countUsers', type: 'Int', width: 80},
    {label: t('Guests'), colId: 'countGuests', type: 'Int', width: 80},
    {label: t('Public'), colId: 'hasEveryone', type: 'Bool', width: 80},

    {label: t('Created By'), colId: 'createdBy', type: 'Int'},
    {label: t('Created At'), colId: 'createdAtMs', ...Date},
    {label: t('Updated At'), colId: 'updatedAtMs', ...Date},
    {label: t('URL Id'), colId: 'urlId', type: 'Text', width: 150},
    {label: t('Doc Type'), colId: 'type', type: 'Text', ...defaultValue('Standard')},
    {label: t('Is Pinned'), colId: 'isPinned', type: 'Bool', width: 80},

    ...(opts.forWs ? [] : [
      {label: t('Workspace Id'), colId: 'workspaceId', type: 'Int'},
      {label: t('Workspace Name'), colId: 'workspaceName', type: 'Text', ...Link('workspaces', 'workspaceId')},
    ]),

    ...(opts.forOrg || opts.forWs ? [] : parentOrgColumns()),

    {label: t('Usage Rows'), type: 'Int', colId: 'usageRows'},
    {label: t('Usage Data Bytes'), type: 'Int', colId: 'usageDataBytes', width: 120},
    {label: t('Usage Attachment Bytes'), type: 'Int', colId: 'usageAttachmentBytes', width: 160},
  ];
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
