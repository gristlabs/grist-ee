import { isFreePlan } from 'app/common/Features';
import { encodeUrl, GristLoadConfig, IGristUrlState } from 'app/common/gristUrls';
import { FullUser } from 'app/common/LoginSessionAPI';
import * as roles from 'app/common/roles';
import { StringUnion } from 'app/common/StringUnion';
import { BillingAccount } from 'app/gen-server/entity/BillingAccount';
import { Document } from 'app/gen-server/entity/Document';
import { Organization } from 'app/gen-server/entity/Organization';
import { User } from 'app/gen-server/entity/User';
import { Workspace } from 'app/gen-server/entity/Workspace';
import { HomeDBManager, UserChange, UserIdDelta } from "app/gen-server/lib/homedb/HomeDBManager";
import { SendGridAddress, SendGridBillingTemplate, SendGridInviteResourceKind,
         SendGridInviteTemplate, SendGridMail, SendGridMemberChangeTemplate,
         SendGridPersonalization, TwoFactorEvent } from 'app/gen-server/lib/NotifierTypes';
import { GristServer } from 'app/server/lib/GristServer';
import { INotifier } from 'app/server/lib/INotifier';
import log from 'app/server/lib/log';
import { flatten, pick, sortBy, upperFirst } from 'lodash';
import moment from 'moment';

type LoggingList = Array<() => Promise<void>>;

export interface Mailer<T> {
  content?: T;
  logging?: LoggingList;
  invitedUsers?: FullUser[];
  label: string;
}

export interface NotifierToolsOptions {
  unsubscribeGroup?: {
    billingManagers?: number,
    invites?: number,
  };
  address: {
    from: {
      name: string,
      email: string,
    }
  };
}

export interface NotifierConfig {
  gristServer: GristServer;
  dbManager: HomeDBManager;
  options: NotifierToolsOptions;
}

/**
 * This takes NotifiableActions and expands the information
 * provided into everything needed for a complete email
 * notification.
 */
export class NotifierTools {
  private _gristConfig: GristLoadConfig;
  private _homeUrl: string;

  public constructor(private _gristServer: GristServer,
                     private _dbManager: HomeDBManager,
                     private _options: NotifierToolsOptions
  ) {
    this._gristConfig = this._gristServer.getGristConfig();
    const _homeUrl = this._gristConfig.homeUrl;
    if (!_homeUrl) { throw new Error('Notifier requires a home URL'); }
    this._homeUrl = _homeUrl;
  }

  public async runLogging(logging?: LoggingList) {
    for (const logger of logging || []) {
      await logger();
    }
  }

  public async addUser(userId: number, resource: Organization|Workspace|Document,
                       delta: UserIdDelta, membersBefore: Map<roles.NonGuestRole,
                       User[]>): Promise<Mailer<SendGridMail>> {
    // Get ids of pre-existing users.
    const existingUsers = flatten([...membersBefore.values()]).map(u => u.id);
    // Set up a list of user ids that should be ignored.
    const ignoredUsers = new Set([userId, this._dbManager.getEveryoneUserId(),
                                  this._dbManager.getAnonymousUserId(), ...existingUsers]);
    // Get ids of users for whom changes were requested.
    // Ignore any changes by the current user (should not in fact be possible currently),
    // or invitations to anonymous/everyone, or removal of users, or changes in
    // the access level of a user who already had access.
    const ids = Object.keys(delta)
      .filter(id => delta[id] !== null)
      .map(id => parseInt(id, 10))
      .filter(id => !ignoredUsers.has(id));
    // Get details of users for whom changes were requested, since we may need those
    // details for sending the emails and expanding the email template.
    const invitedUsers = await Promise.all(ids.map(id => this._dbManager.getFullUser(id)));
    // We need to know the details of the user sending the email.
    const host = await this._dbManager.getFullUser(userId);
    // We'll want to send a link to the resource for which access is being granted, so
    // we go through the steps the front-end would use to construct such a link.
    let kind: SendGridInviteResourceKind;
    if (resource instanceof Organization) {
      kind = 'team site';
    } else if (resource instanceof Workspace) {
      kind = 'workspace';
    } else {
      kind = 'document';
    }
    const url = await this._makeInviteUrl(resource);
    // Ok, we've gathered all the information we may need.  Time to prepare a payload
    // to send to sendgrid.
    const personalizations: SendGridPersonalization[] = [];
    for (const user of sortBy(invitedUsers, 'email')) {
      const role = delta[user.id] as string;
      const template: SendGridInviteTemplate = {
        type: 'invite',
        user,
        host,
        resource: {
          ...describeKind(kind),
          name: resource.name,
          url
        },
        access: {
          role,
          canEditAccess: roles.canEditAccess(role),
          canEdit: roles.canEdit(role),
          canView: roles.canView(role),
        }
      };
      personalizations.push({
        to: [
          {
            email: user.email,
            name: user.name
          }
        ],
        dynamic_template_data: template
      });
    }
    const unsubscribeGroupId = this._options.unsubscribeGroup?.invites;
    if (unsubscribeGroupId === undefined) {
      log.debug('notifications: no unsubscribe group set for invites');
    }
    const emailedUsers = personalizations.map(p => p.to[0].email).sort();
    const invite: SendGridMail|undefined = (emailedUsers.length > 0) ? {
      ...this._fromGristUser(host),
      ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
      personalizations,
    } : undefined;

    return {
      content: invite,
      invitedUsers,
      label: `invite ${emailedUsers} to ${url}`
    };
  }


  public async userChange(change: UserChange): Promise<Mailer<SendGridMail>> {
    const membersBefore = flatten([...change.membersBefore.values()]);
    const membersAfter = flatten([...change.membersAfter.values()]);
    const idsBefore = new Set(membersBefore.map(user => user.id));
    const idsAfter = new Set(membersAfter.map(user => user.id));
    const membersAdded = sortBy(membersAfter.filter(user => !idsBefore.has(user.id)), 'name');
    const membersRemoved = sortBy(membersBefore.filter(user => !idsAfter.has(user.id)), 'name');
    if (membersAdded.length === 0 && membersRemoved.length === 0) { return { label: 'empty' }; }

    const logging: LoggingList = [];
    if (membersAdded.length > 0) {
      logging.push(async () => {
        this._gristServer.getTelemetry().logEvent(null, 'invitedMember', {
          full: {
            count: membersAdded.length,
            siteId: change.org.id,
          },
        });
      });
    }
    if (membersRemoved.length > 0) {
      logging.push(async () => {
        this._gristServer.getTelemetry().logEvent(null, 'uninvitedMember', {
          full: {
            count: membersRemoved.length,
            siteId: change.org.id,
          },
        });
      });
    }
    const added = await Promise.all(membersAdded.map(user => this._dbManager.getFullUser(user.id)));
    const removed = await Promise.all(membersRemoved.map(user => this._dbManager.getFullUser(user.id)));
    const initiatingUser = await this._dbManager.getFullUser(change.userId);
    const account = await this._dbManager.getFullBillingAccount(change.org.billingAccountId);
    const env: SendGridMemberChangeTemplate = {
      ...this._getBillingTemplate(account),
      added,
      removed,
      initiatingUser,
      countBefore: change.countBefore,
      countAfter: change.countAfter,
      paidPlan: !isFreePlan(account.product.name),
      type: 'memberChange',
    };
    const unsubscribeGroupId = this._options.unsubscribeGroup?.billingManagers;
    if (unsubscribeGroupId === undefined) {
      log.debug('notifications: no unsubscribe group set for billingManagers');
    }
    const mail: SendGridMail = {
      ...this._fromGrist(),
      ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
      personalizations: [{
        to: this._getManagers(account).map(user => this._asSendGridAddress(user)),
        dynamic_template_data: env
      }],
    };
    return {
      content: mail,
      logging,
      label: `memberChange for ${change.org.name}`,
    };
  }

  public async addBillingManager(hostUserId: number, addUserId: number,
                                 orgs: Organization[]): Promise<Mailer<SendGridMail>> {
    if (orgs.length === 0) { return { label: 'empty' }; }
    if (orgs.length !== 1) { throw new Error('cannot deal with multi-org plans'); }
    const org = orgs[0];
    const host = await this._dbManager.getFullUser(hostUserId);
    const user = await this._dbManager.getFullUser(addUserId);
    const state: IGristUrlState = {};
    state.org = this._dbManager.normalizeOrgDomain(org.id, org.domain, org.ownerId);
    state.billing = 'billing';
    const url = encodeUrl(this._gristConfig, state, new URL(this._homeUrl));
    const kind = 'team site';
    const template: SendGridInviteTemplate = {
      type: 'billingManagerInvite',
      user,
      host,
      resource: {
        ...describeKind(kind),
        name: org.name,
        url
      },
      access: {
        role: 'billing',
        canManageBilling: true
      }
    };
    const personalizations = [{
      to: [
        {
          email: user.email,
          name: user.name
        }
      ],
      dynamic_template_data: template
    }];
    const unsubscribeGroupId = this._options.unsubscribeGroup?.invites;
    if (unsubscribeGroupId === undefined) {
      log.debug('notifications: no unsubscribe group set for invites');
    }
    const invite: SendGridMail = {
      ...this._fromGristUser(host),
      // unsubscribe group to use is a bit ambiguous - going for invites since eventually
      // user may need to accept invite prior to being actively a billing manager.
      ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
      personalizations,
    };
    return {
      content: invite,
      label: `invite billing manager ${user.email} to ${url}`,
    };
  }

  /**
   * Send email to billing managers when Stripe warns us that a trial period is ending
   * soon.  Provides a link to billing page where details can be checked and action taken.
   */
  public async trialPeriodEndingSoon(
    account: BillingAccount,
    subscription: {trial_end: number | null}
  ) {
    let howSoon: string|null = null;
    if (subscription.trial_end) {
      // howSoon will be set normally to "3 days", but if a hook is called late (or when
      // changing trialEnd manually), could be e.g. "a day".
      const trialEnd = new Date(subscription.trial_end * 1000);
      howSoon = moment.duration(moment().diff(trialEnd)).humanize();
    }
    const logging = [
      async () => {
        log.debug(`notifications: sending trialPeriodEndingSoon for ${account.stripeCustomerId} (${howSoon})`);
      }
    ];
    // Ideally, to get managers and orgs, we'd just pull in the relations above.
    // But there's some useful cleanup done in getFullBillingAccount.
    const fullAccount = await this._dbManager.getFullBillingAccount(account.id);
    const unsubscribeGroupId = this._options.unsubscribeGroup?.billingManagers;
    if (unsubscribeGroupId === undefined) {
      log.debug('notifications: no unsubscribe group set for billingManagers');
    }
    const mail: SendGridMail = {
      ...this._fromGrist(),
      ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
      personalizations: [{
        to: this._getManagers(fullAccount).map(user => this._asSendGridAddress(user)),
        dynamic_template_data: {
          ...this._getBillingTemplate(fullAccount),
          howSoon,
        }
      }],
      // Notification of end of trial period is important to give people a chance
      // to terminate their subscription or update their card information.
      ...this._withoutUnsubscribe(),
    };
    return {
      logging,
      content: mail,
      label: `trialPeriodEndingSoon for ${fullAccount.orgs.map(o => o.name)}`,
    };
  }

  /**
   * Handler for 2FA events. Notifies the user when two-factor authentication config is changed
   * for their account.
   */
  public async twoFactorStatusChanged(event: TwoFactorEvent, userId: number, method?: 'TOTP' | 'SMS') {
    const templateData = method ? {
      type: event,
      method,
    } : {};
    const mail = await this._buildTwoFactorEmail(
      userId,
      event,  // crude templateId
      templateData);
    return {
      content: mail,
      label: `${event} for user ${userId}`,
    };
  }

  /**
   * Compile a list of billing managers in a format compatible with SendGrid api.
   */
  private _getManagers(account: BillingAccount): FullUser[] {
    // TODO: correct typing on account managers.
    return account.managers as any[] as FullUser[];
  }

  private _asSendGridAddress(user: FullUser): SendGridAddress {
    return pick(user, 'email', 'name');
  }

  /**
   * Fill in the SendGrid "from" and "reply_to" fields with Grist's email.  At some
   * point we may want to switch "reply_to" to some noreply address.
   */
  private _fromGrist(): Pick<SendGridMail, 'from'|'reply_to'> {
    return {
      from: this._options.address.from,
      reply_to: this._options.address.from
    };
  }

  /**
   * Fill in the SendGrid "from" and "reply_to" fields when the sender is known, e.g.:
   * From: "Bob (via Grist) <support@getgrist.com>"
   * Reply-To: "Bob <bob@example.com>".
   */
  private _fromGristUser(sender: FullUser): Pick<SendGridMail, 'from'|'reply_to'> {
    return {
      from: {...this._options.address.from, name: `${sender.name} (via Grist)`},
      reply_to: {email: sender.email, name: sender.name},
    };
  }

  /**
   * Configure which sendgrid unsubscribe group to use for an email.
   */
  private _withUnsubscribe(unsubscribeGroupId: number) {
    return {
      asm: {
        group_id: unsubscribeGroupId
      }
    };
  }

  /**
   * Send email without respecting unsubscribe settings - this should
   * be limited to financially/technically important emails, not
   * marketing or non-critical notifications.  See:
   *   https://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/index.html
   */
  private _withoutUnsubscribe() {
    return {
      mail_settings: {
        bypass_list_management: {
          enable: true
        }
      }
    };
  }

  /**
   * Compile basic information needed by billing managers - org details, link to
   * org, link to org billing page.
   */
  private _getBillingTemplate(account: BillingAccount): SendGridBillingTemplate {
    const state: IGristUrlState = {};
    if (account.orgs.length !== 1) { throw new Error('need exactly one org'); }
    const org = account.orgs[0]!;
    state.org = this._dbManager.normalizeOrgDomain(org.id, org.domain, org.ownerId);
    const orgUrl = encodeUrl(this._gristConfig, state, new URL(this._homeUrl));
    state.billing = 'billing';
    const billingUrl = encodeUrl(this._gristConfig, state, new URL(this._homeUrl));
    return {
      type: 'billing',
      org: pick(org, ['id', 'name']),
      billingUrl,
      orgUrl
    };
  }

  /**
   * Returns a SendGridMail object appropriate for two-factor authentication emails.
   */
  private async _buildTwoFactorEmail(
    userId: number,
    templateId: string,
    templateData?: {[key: string]: any},
  ): Promise<SendGridMail> {
    const {email, name} = await this._dbManager.getFullUser(userId);
    return {
      ...this._fromGrist(),
      personalizations: [{
        to: [{email, name}],
        dynamic_template_data: templateData ?? {},
      }],
      ...this._withoutUnsubscribe(),
    };
  }

  private async _makeInviteUrl(resource: Organization|Workspace|Document) {
    const url = new URL(await this._gristServer.getResourceUrl(resource));
    url.searchParams.set('utm_id', `invite-${getResourceName(resource)}`);
    return url.href;
  }
}



/**
 * Describe the kind of resource in various ways to make handlebar templates
 * easier to write.
 */
function describeKind(kind: SendGridInviteResourceKind) {
  return {
    kind,
    kindUpperFirst: upperFirst(kind),
    isDocument: kind === 'document',
    isWorkspace: kind === 'workspace',
    isTeamSite: kind === 'team site'
  };
}

const ResourceName = StringUnion('org', 'ws', 'doc');
type ResourceName = typeof ResourceName.type;

function getResourceName(resource: Organization|Workspace|Document): ResourceName|null {
  if (resource instanceof Organization) {
    return 'org';
  } else if (resource instanceof Workspace) {
    return 'ws';
  } else if (resource instanceof Document) {
    return 'doc';
  } else {
    return null;
  }
}

export class NotifierBase implements INotifier {
  public addUser = this._wrapEvent('addUser');
  public addBillingManager = this._wrapEvent('addBillingManager');
  public firstLogin = this._wrapEvent('firstLogin');
  public teamCreator = this._wrapEvent('teamCreator');
  public userChange = this._wrapEvent('userChange');
  public trialPeriodEndingSoon = this._wrapEvent('trialPeriodEndingSoon');
  public trialingSubscription = this._wrapEvent('trialingSubscription');
  public scheduledCall = this._wrapEvent('scheduledCall');
  public streamingDestinationsChange = this._wrapEvent('streamingDestinationsChange');
  public twoFactorStatusChanged = this._wrapEvent('twoFactorStatusChanged');

  private _tool: NotifierTools;

  public constructor(config: NotifierConfig) {
    this._tool = new NotifierTools(config.gristServer,
                                   config.dbManager,
                                   config.options);
  }

  public async applyNotification(_mail: Mailer<SendGridMail>) {
    // nothing to do, by default.
  }

  public async deleteUser(_userId: number) {
    // nothing to do, by default.
  }

  private _wrapEvent<Name extends keyof INotifier>(eventName: Name): INotifier[Name] {
    return (async (...args: any[]) => {
      await this.applyNotification(
        await (this._tool[eventName as keyof NotifierTools] as any)(...args)
      );
    }) as INotifier[Name];
  }
}
