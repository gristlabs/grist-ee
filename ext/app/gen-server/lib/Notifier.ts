import {normalizeEmail} from 'app/common/emails';
import {encodeUrl, GristLoadConfig, IGristUrlState} from 'app/common/gristUrls';
import {isNonNullish} from 'app/common/gutil';
import {FullUser} from 'app/common/LoginSessionAPI';
import * as roles from 'app/common/roles';
import {StringUnion} from 'app/common/StringUnion';
import {BillingAccount} from "app/gen-server/entity/BillingAccount";
import {Document} from "app/gen-server/entity/Document";
import {Organization} from "app/gen-server/entity/Organization";
import {User} from "app/gen-server/entity/User";
import {Workspace} from 'app/gen-server/entity/Workspace';
import {GristServer} from 'app/server/lib/GristServer';
import {
  HomeDBManager,
  NotifierEvents,
  UserChange,
  UserIdDelta
} from 'app/gen-server/lib/HomeDBManager';
import {INotifier} from 'app/server/lib/INotifier';
import log from 'app/server/lib/log';
import flatten = require('lodash/flatten');
import pick = require('lodash/pick');
import sortBy = require('lodash/sortBy');
import upperFirst = require('lodash/upperFirst');
import moment from 'moment';
import fetch from 'node-fetch';

export const SENDGRID_API_CONFIG = {
  // Main API prefix.
  prefix: "https://api.sendgrid.com/v3",
  // API endpoint for adding a user to a list.
  enroll: "/marketing/contacts",
  // API endpoint for finding a user in SendGrid.
  search: "/marketing/contacts/search",
  // API endpoint for finding a user in SendGrid by email.
  // TODO: could replace use of search with this.
  searchByEmail: "/marketing/contacts/search/emails",
  // API endpoint for removing a user from a list.
  listRemove: "/marketing/lists/{{id}}/contacts",
  // API endpoint for sending an email.
  send: "/mail/send",
};

// TODO: move all sendgrid interactions to a queue.

export const TwoFactorEvents = StringUnion(
  'twoFactorMethodAdded',
  'twoFactorMethodRemoved',
  'twoFactorPhoneNumberChanged',
  'twoFactorEnabled',
  'twoFactorDisabled',
);

export type TwoFactorEvent = typeof TwoFactorEvents.type;

/**
 * Structure of sendgrid email requests.  Each request references a template
 * (stored on sendgrid site) and a list of people to send a copy of that template
 * to, along with the relevant values to use for template variables.
 */
export interface SendGridMail {
  personalizations: SendGridPersonalization[];
  from: SendGridAddress;
  reply_to: SendGridAddress;
  template_id: string;
  asm?: {  // unsubscribe settings
    group_id: number;
  };
  mail_settings?: {
    bypass_list_management?: {
      enable: boolean;
    }
  };
}

export interface SendGridContact {
  contacts: [{
    email: string;
    first_name: string;
    last_name: string;
  }],
  list_ids?: string[];
  custom_fields?: Record<string, any>;
}

export interface SendGridAddress {
  email: string;
  name: string;
}

export interface SendGridPersonalization {
  to: SendGridAddress[];
  dynamic_template_data: {[key: string]: any};
}

/**
 * Structure of sendgrid invite template.  This is entirely under our control, it
 * is the information we choose to send to an email template for invites.
 */

export interface SendGridInviteTemplate {
  user: FullUser;
  host: FullUser;
  resource: SendGridInviteResource;
  access: SendGridInviteAccess;
}

export interface SendGridInviteResource {
  kind: SendGridInviteResourceKind;
  kindUpperFirst: string;
  name: string;
  url: string;
}

export type SendGridInviteResourceKind = 'team site' | 'workspace' | 'document';

export interface SendGridInviteAccess {
  role: string;
  canEditAccess?: boolean;
  canEdit?: boolean;
  canView?: boolean;
  canManageBilling?: boolean;
}

// Common parameters included in emails to active billing managers.
export interface SendGridBillingTemplate {
  org: {id: number, name: string};
  orgUrl: string;
  billingUrl: string;
}

export interface SendGridMemberChangeTemplate extends SendGridBillingTemplate {
  initiatingUser: FullUser;
  added: FullUser[];
  removed: FullUser[];
  org: {id: number, name: string};
  countBefore: number;
  countAfter: number;
  orgUrl: string;
  billingUrl: string;
}

/**
 * Format of sendgrid responses when looking up a user by email address using
 * SENDGRID.search
 */
export interface SendGridSearchResult {
  contact_count: number;
  result: SendGridSearchHit[];
}

export interface SendGridSearchHit {
  id: string;
  email: string;
  list_ids: string[];
}

/**
 * Alternative format of sendgrid responses when looking up a user by email
 * address using SENDGRID.searchByEmail
 *   https://docs.sendgrid.com/api-reference/contacts/get-contacts-by-emails
 */
export interface SendGridSearchResultVariant {
  result: Record<string, SendGridSearchPossibleHit>;
}

/**
 * Documentation is contradictory on format of results when contacts not found, but if
 * something is found there should be a contact field.
 */
export interface SendGridSearchPossibleHit {
  contact?: SendGridSearchHit;
}

export interface SendGridConfig {
  address: {
    from: {
      email: string;
      name: string;
    }
  },
  template: {
    invite?: string;
    billingManagerInvite?: string;
    memberChange?: string;
    trialPeriodEndingSoon?: string;
    twoFactorMethodAdded?: string;
    twoFactorMethodRemoved?: string;
    twoFactorPhoneNumberChanged?: string;
    twoFactorEnabled?: string;
    twoFactorDisabled?: string;
  },
  list: {
    singleUserOnboarding?: string;
    appSumoSignUps?: string;
    trial?: string;
  },
  unsubscribeGroup: {
    invites?: number;
    billingManagers?: number;
  },
  field?: {
    callScheduled?: string;
    userRef?: string;
  },
}


/**
 * A notifier that sends no messages, and is sufficient only for unsubscribing/removing a user.
 */
export class UnsubscribeNotifier implements INotifier {
  private _testPendingNotifications: number = 0;  // for test purposes, track notification in progress

  public constructor(protected _dbManager: HomeDBManager, protected _sendgridConfig: SendGridConfig) {
  }

  public async deleteUser(userId: number) {
    const user = await this._dbManager.getFullUser(userId);
    const email = user.email;
    const description = `deleteUser ${email}`;
    const response = await this._fetch(SENDGRID_API_CONFIG.searchByEmail, {
      method: 'POST',
      body: {
        emails: [email],   // email lookup is case insensitive
      }
    });
    // Documentation on this method is inconsistent. Empirically, if a contact is not
    // found, we get a 404 response. It is fine for the contact not to be found, it may
    // have been deleted manually, or never quite finished enrollment.
    if (!response.ok && response.status !== 404) {
      throw new Error(`sendgrid search problem ${response.status} ${response.statusText}: ${description}`);
    }
    if (response.ok) {
      const match: SendGridSearchResultVariant = await response.json();
      const contact = match.result[email]?.contact;
      if (!contact) {
        log.debug(`sendgrid does not have user: ${description}`);
        return;
      }
      const id = contact.id;
      await this._fetch(SENDGRID_API_CONFIG.enroll + '?' + new URLSearchParams({
        ids: id
      }), {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`sendgrid delete problem ${response.status} ${response.statusText}: ${description}`);
      } else {
        log.debug(`sendgrid deleted user: ${description}`);
      }
    } else {
      log.debug(`sendgrid did not find user: ${description}`);
    }
  }

  // for test purposes, check if any notifications are in progress
  public get testPending(): boolean {
    return this._testPendingNotifications > 0;
  }

  /**
   * Call node-fetch, with the path prefixed appropriately, any variables expanded,
   * necessary headers added, and body stringified.  TODO: This would be a good place to
   * add retries.
   */
  protected async _fetch(path: string, options: {method: string, body?: any}) {
    const sendGridKey = this._getKey();
    if (!sendGridKey) { throw new Error('sendgrid not available'); }
    const headers = {
      'Authorization': `Bearer ${sendGridKey}`,
      'Content-Type': 'application/json'
    };
    if (options.body) {
      options.body = JSON.stringify(options.body);
    }
    return fetch(`${SENDGRID_API_CONFIG.prefix}${path}`, {
      headers,
      ...options
    });
  }

  /**
   * Get sendgrid api key if available (otherwise returns undefined).
   */
  protected _getKey(): string | undefined {
    return process.env.SENDGRID_API_KEY;
  }

  /**
   * Small wrapper for listeners to keep _testPendingNotifications positive while
   * there are still events to be handled.  This allows tests to wait before panicking
   * about missing emails.
   */
  protected async _handleEvent(callback: () => Promise<void>) {
    this._testPendingNotifications++;
    try {
      await callback();
    } catch (e) {
      // Catch error since as an event handler we can't return one.
      log.error("Notifier failed:", e);
    } finally {
      this._testPendingNotifications--;
    }
  }
}


/**
 * Manager for sending notifications to users about resources they've been invited to.
 * Has access to the database so that it can look up everything it needs to know about
 * for describing users, and it knows the home url so that it can construct links for
 * resources.
 */
export class Notifier extends UnsubscribeNotifier implements INotifier {
  private _gristConfig: GristLoadConfig;
  private _homeUrl: string;

  public constructor(
    protected _dbManager: HomeDBManager,
    private _gristServer: GristServer,
    protected _sendgridConfig: SendGridConfig,
  ) {
    super(_dbManager, _sendgridConfig);
    this._gristConfig = _gristServer.getGristConfig();
    if (!this._gristConfig.homeUrl) { throw new Error('Notifier requires a home URL'); }
    this._homeUrl = this._gristConfig.homeUrl;

    for (const method of NotifierEvents.values) {
      this._dbManager.on(method, (...args) => (this[method] as any)(...args));
    }
  }

  /**
   * Send an email to a user, if the sendgrid api is available (requires SENDGRID_API_KEY).
   * @param payload: body of message, in the format sendgrid expects
   * @param description: a short summary of email for use in log messages
   */
  public async sendMessage(body: SendGridMail, description: string) {
    if (!this._getKey()) {
      log.debug(`sendgrid skipped: ${description}`);
      return;
    }
    const response = await this._fetch(SENDGRID_API_CONFIG.send, {
      method: 'POST',
      body
    });
    if (!response.ok) {
      log.error(`sendgrid error ${response.status} ${response.statusText}: ${description}`);
    } else {
      log.debug(`sendgrid sent: ${description}`);
    }
  }

  /**
   * Send new or updated contact information to sendgrid.
   */
  public async sendContactInfo(body: SendGridContact, description: string) {
    if (!this._getKey()) {
      log.debug(`sendgrid skipped: ${description}`);
      return;
    }
    const response = await this._fetch(SENDGRID_API_CONFIG.enroll, {
      method: 'PUT',
      body,
    });
    if (!response.ok) {
      log.error(`sendgrid error ${response.status} ${response.statusText}: ${description}`);
    } else {
      log.debug(`sendgrid sent: ${description}`);
    }
  }

  /**
   * Handler for addUser events.  This gets called when a PATCH is made to an /access endpoint.
   * It is called with a pre-existing list of members, and the requested changes.
   */
  public async addUser(userId: number, resource: Organization|Workspace|Document,
                       delta: UserIdDelta, membersBefore: Map<roles.NonGuestRole, User[]>) {
    return this._handleEvent(async () => {
      const templateId = this._sendgridConfig.template.invite;
      if (!templateId) {
        log.debug(`sendgrid skipped: no invite template id set`);
        return;
      }
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
      const url = await this._gristServer.getResourceUrl(resource);
      // Ok, we've gathered all the information we may need.  Time to prepare a payload
      // to send to sendgrid.
      const personalizations: SendGridPersonalization[] = [];
      for (const user of sortBy(invitedUsers, 'email')) {
        const role = delta[user.id] as string;
        const template: SendGridInviteTemplate = {
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
      const unsubscribeGroupId = this._sendgridConfig.unsubscribeGroup.invites;
      if (unsubscribeGroupId === undefined) {
        log.debug('sendgrid: no unsubscribe group set for invites');
      }
      const invite: SendGridMail = {
        ...this._fromGristUser(host),
        ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
        personalizations,
        template_id: templateId,
      };
      const emailedUsers = personalizations.map(p => p.to[0].email).sort();
      if (emailedUsers.length > 0) {
        await this.sendMessage(invite, `invite ${emailedUsers} to ${url}`);
      }
      for (const user of invitedUsers) {
        // some users may need to be switched over to team onboarding list.
        await this._updateList(user);
      }
    });
  }

  /**
   * Handler for addBillingManager events.  This gets called when a PATCH is made to the
   * /billing/managers endpoint.
   */
  public async addBillingManager(hostUserId: number, addUserId: number, orgs: Organization[]) {
    return this._handleEvent(async () => {
      const templateId = this._sendgridConfig.template.billingManagerInvite;
      if (!templateId) {
        log.debug(`sendgrid skipped: no billingManagerInvite template id set`);
        return;
      }
      if (orgs.length === 0) { return; }
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
      const unsubscribeGroupId = this._sendgridConfig.unsubscribeGroup.invites;
      if (unsubscribeGroupId === undefined) {
        log.debug('sendgrid: no unsubscribe group set for invites');
      }
      const invite: SendGridMail = {
        ...this._fromGristUser(host),
        // unsubscribe group to use is a bit ambiguous - going for invites since eventually
        // user may need to accept invite prior to being actively a billing manager.
        ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
        personalizations,
        template_id: templateId,
      };
      await this.sendMessage(invite, `invite billing manager ${user.email} to ${url}`);
    });
  }

  /**
   * Handler for firstLogin events.  Adds user to an onboarding in sendgrid.
   * We wait until this point so we have the user's name, not just email address.
   */
  public async firstLogin(user: FullUser) {
    return this._handleEvent(async () => {
      await this._updateList(user, true);
    });
  }

  /**
   * Handler for teamCreator events, emitted when a user creates a team.
   */
  public async teamCreator(userId: number) {
    return this._handleEvent(async () => {
      const user = await this._dbManager.getFullUser(userId);
      // Make sure user is on all the lists they merit being on, if we know their name
      // already.
      if (user.name) {
        await this._updateList(user, true);
      }
    });
  }

  /**
   * Handler for userChange events.  Notifies billing managers when users are added or
   * removed from organization.
   */
  public async userChange(change: UserChange) {
    return this._handleEvent(async () => {
      const templateId = this._sendgridConfig.template.memberChange;
      if (!templateId) {
        log.debug(`sendgrid skipped: no memberChange template id set`);
        return;
      }
      const membersBefore = flatten([...change.membersBefore.values()]);
      const membersAfter = flatten([...change.membersAfter.values()]);
      const idsBefore = new Set(membersBefore.map(user => user.id));
      const idsAfter = new Set(membersAfter.map(user => user.id));
      const membersAdded = sortBy(membersAfter.filter(user => !idsBefore.has(user.id)), 'name');
      const membersRemoved = sortBy(membersBefore.filter(user => !idsAfter.has(user.id)), 'name');
      if (membersAdded.length === 0 && membersRemoved.length === 0) { return; }
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
      };
      const unsubscribeGroupId = this._sendgridConfig.unsubscribeGroup.billingManagers;
      if (unsubscribeGroupId === undefined) {
        log.debug('sendgrid: no unsubscribe group set for billingManagers');
      }
      const mail: SendGridMail = {
        ...this._fromGrist(),
        ...(unsubscribeGroupId !== undefined ? this._withUnsubscribe(unsubscribeGroupId) : {}),
        personalizations: [{
          to: this._getManagers(account).map(user => this._asSendGridAddress(user)),
          dynamic_template_data: env
        }],
        template_id: templateId,
      };
      await this.sendMessage(mail, `memberChange for ${change.org.name}`);
    });
  }

  /**
   * Send email to billing managers when Stripe warns us that a trial period is ending
   * soon.  Provides a link to billing page where details can be checked and action taken.
   */
  public async trialPeriodEndingSoon(
    account: BillingAccount,
    subscription: {trial_end: number | null}
  ) {
    await this._handleEvent(async () => {
      const templateId = this._sendgridConfig.template.trialPeriodEndingSoon;
      if (!templateId) {
        log.debug(`sendgrid skipped: no trialPeriodEndingSoon template id set`);
        return;
      }
      let howSoon: string|null = null;
      if (subscription.trial_end) {
        // howSoon will be set normally to "3 days", but if a hook is called late (or when
        // changing trialEnd manually), could be e.g. "a day".
        const trialEnd = new Date(subscription.trial_end * 1000);
        howSoon = moment.duration(moment().diff(trialEnd)).humanize();
      }
      log.debug(`sendgrid: sending trialPeriodEndingSoon for ${account.stripeCustomerId} (${howSoon})`);
      // Ideally, to get managers and orgs, we'd just pull in the relations above.
      // But there's some useful cleanup done in getFullBillingAccount.
      const fullAccount = await this._dbManager.getFullBillingAccount(account.id);
      const unsubscribeGroupId = this._sendgridConfig.unsubscribeGroup.billingManagers;
      if (unsubscribeGroupId === undefined) {
        log.debug('sendgrid: no unsubscribe group set for billingManagers');
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
        template_id: templateId,
        // Notification of end of trial period is important to give people a chance
        // to terminate their subscription or update their card information.
        ...this._withoutUnsubscribe(),
      };
      await this.sendMessage(mail, `trialPeriodEndingSoon for ${fullAccount.orgs.map(o => o.name)}`);
    });
  }

  /**
   * Called when an account enters trial mode. Puts billing managers
   * in a special trial list in sendgrid.
   */
  public async trialingSubscription(account: BillingAccount) {
    const trialListId = this._sendgridConfig.list.trial;
    if (!trialListId) { return; }
    await this._handleEvent(async () => {
      const fullAccount = await this._dbManager.getFullBillingAccount(account.id);
      const managers = this._getManagers(fullAccount);
      await Promise.all(managers.map(
        manager => this._addOrUpdateContact(manager, {listIds: [trialListId]})
      ));
    });
  }

  /**
   * Called when a user schedules a call. Sets the call_scheduled custom
   * field in sendgrid for that user.
   */
  public async scheduledCall(userRef: string) {
    await this._handleEvent(async () => {
      const user = await this._dbManager.getUserByRef(userRef);
      const fullUser = user && this._dbManager.makeFullUser(user);
      log.debug('Notifier scheduledCall', {userRef, fullUser});
      if (fullUser) {
        await this._addOrUpdateContact(fullUser, {
          customFields: {
            callScheduled: 1,
          },
        });
      }
    });
  }

  /**
   * Handler for 2FA events. Notifies the user when two-factor authentication config is changed
   * for their account.
   */
  public async twoFactorStatusChanged(event: TwoFactorEvent, userId: number, method?: 'TOTP' | 'SMS') {
    await this._handleEvent(async () => {
      const templateId = this._sendgridConfig.template[event];
      if (!templateId) {
        log.error(`Notifier failed: unable to find template id for 2FA event ${event}`);
        return;
      }
      const templateData = method ? {method} : {};
      const mail = await this._buildTwoFactorEmail(userId, templateId, templateData);
      await this.sendMessage(mail, `${event} for user ${userId}`);
    });
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
      template_id: templateId,
      ...this._withoutUnsubscribe(),
    };
  }

  /**
   * Check what list a user should be on, and make updates if needed.
   * If `create` is set, the user can be added as a fresh contact
   * if they haven't already.  This should only be set if we are
   * sure the user has signed up.
   */
  private async _updateList(user: FullUser, create: boolean = false) {
    const lists: Array<keyof SendGridConfig['list']> = [];
    if (this._sendgridConfig.list.singleUserOnboarding) {
      lists.push('singleUserOnboarding');
    }
    if (create && this._sendgridConfig.list.appSumoSignUps) {
      // There is an extra list for "sumolings" from AppSumo.  Check if this
      // user is a sumoling, by looking for an org they've activated.  Users
      // invited to an AppSumo-activated org are not treated as "sumolings".
      const org = await this._dbManager.getOrgByExternalId(`appsumo/${user.email}`);
      if (org) {
        lists.push('appSumoSignUps');
      }
    }
    await this._setList(user, lists, create);
  }

  /**
   * Place user on a specific list or lists.
   * If `create` is set, the user can be added as a fresh contact
   * if they haven't already.  This should only be set if we are
   * sure the user has signed up.
   */
  private async _setList(user: FullUser, listNames: Array<keyof SendGridConfig['list']>,
    create: boolean) {
    const email = normalizeEmail(user.email);
    const description = `setList ${email} ${listNames}`;
    if (!this._getKey()) {
      log.debug(`sendgrid skipped: ${description}`);
      return;
    }
    const listIds = listNames
      .map(name => this._sendgridConfig.list[name])
      .filter(isNonNullish);
    // There's no documentation I can find on what sendgrid calls "SGQL", and
    // experimentation doesn't help much either.  Not sure what whitelist should
    // be or how quoting can be achieved.
    const safeEmail = email.replace(/['"%]/g, '');
    const response = await this._fetch(SENDGRID_API_CONFIG.search, {
      method: 'POST',
      body: {
        query: `primary_email LIKE '${safeEmail}%'`  // this looks silly but any small change
                                                     // in syntax from the one example in docs
                                                     // results in complete failure.
      }
    });
    let match: SendGridSearchHit | undefined;
    if (!response.ok) {
      log.error(`sendgrid warning ${response.status} ${response.statusText}: ${description}`);
      // continue in any case to add or update contact.
    } else {
      const searchResult: SendGridSearchResult = await response.json();
      match = searchResult.result.find(hit => hit.email === email);
    }
    if (!match) {
      if (create) { await this._addOrUpdateContact(user, {listIds}); }
      return;
    }
    if (listIds.every(listId => match!.list_ids.includes(listId))) {
      return;
    }
    await this._addOrUpdateContact(user, {listIds});
  }

  /**
   * Put user on a list.  There's a funky asymmetry between the way users are added
   * to lists and the way they are removed from lists.
   * Update: there is an endpoint for adding users to lists directly now, but
   * it uses a different numeric list id rather than the text id we store, so
   * we still don't use it.
   */
  private async _addOrUpdateContact(user: FullUser, options: {
    listIds?: string[],
    customFields?: {
      callScheduled?: number,
    },
  }) {
    // To pass on name to sendgrid, we need to divide into first and last parts.
    // Split name up brutally.  Hopefully they'll just be added together again when
    // email is sent.
    const parts = user.name.split(' ');
    const first = parts[0] || '';
    const last = parts.slice(1).join(' ');
    const contact = {
      email: normalizeEmail(user.email), // don't want to send multiple emails to same mailbox
      first_name: first.substr(0, 50),   // this is max length for this field in sendgrid
      last_name: last.substr(0, 50)      // this is max length for this field in sendgrid
    };
    const description = `enrollment for ${user.email} with options ${options}`;
    const customFields: Record<string, any> = {};
    if (options.customFields?.callScheduled && this._sendgridConfig.field?.callScheduled) {
      customFields[this._sendgridConfig.field.callScheduled] = options.customFields.callScheduled;
    }
    if (this._sendgridConfig.field?.userRef) {
      customFields[this._sendgridConfig.field.userRef] = user.ref;
    }
    await this.sendContactInfo({
      ...(options.listIds && { list_ids: options.listIds }),
      ...(Object.keys(customFields).length && {
        custom_fields: customFields,
      }),
      contacts: [contact]
    }, description);
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
      org: pick(org, ['id', 'name']),
      billingUrl,
      orgUrl
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
      from: this._sendgridConfig.address.from,
      reply_to: this._sendgridConfig.address.from
    };
  }

  /**
   * Fill in the SendGrid "from" and "reply_to" fields when the sender is known, e.g.:
   * From: "Bob (via Grist) <support@getgrist.com>"
   * Reply-To: "Bob <bob@example.com>".
   */
  private _fromGristUser(sender: FullUser): Pick<SendGridMail, 'from'|'reply_to'> {
    return {
      from: {...this._sendgridConfig.address.from, name: `${sender.name} (via Grist)`},
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
