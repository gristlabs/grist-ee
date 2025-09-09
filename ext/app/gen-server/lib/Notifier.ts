import {normalizeEmail} from 'app/common/emails';
import {GristLoadConfig} from 'app/common/gristUrls';
import {isNonNullish} from 'app/common/gutil';
import {FullUser} from 'app/common/LoginSessionAPI';
import * as roles from 'app/common/roles';
import {BillingAccount} from 'app/gen-server/entity/BillingAccount';
import {Document} from 'app/gen-server/entity/Document';
import {Organization} from 'app/gen-server/entity/Organization';
import {User} from 'app/gen-server/entity/User';
import {Workspace} from 'app/gen-server/entity/Workspace';
import { SENDGRID_CONFIG } from 'app/gen-server/lib/configureSendGridNotifier';
import {
  HomeDBManager,
  NotifierEvents,
  UserChange,
  UserIdDelta
} from 'app/gen-server/lib/homedb/HomeDBManager';
import {
  DocNotificationEvent,
  DocNotificationTemplateBase,
  SendGridConfig,
  SendGridMail,
  SendGridMailWithTemplateId,
  TwoFactorEvent
} from 'app/gen-server/lib/NotifierTypes';
import {
  SendGridContact,
  SendGridSearchHit, SendGridSearchResult, SendGridSearchResultVariant
} from 'app/gen-server/lib/SendGridTypes';
import {appSettings} from 'app/server/lib/AppSettings';
import {GristServer} from 'app/server/lib/GristServer';
import {BaseNotifier, INotifier} from 'app/server/lib/INotifier';
import log from 'app/server/lib/log';
import { Mailer, NotifierTools } from 'app/gen-server/lib/NotifierTools';
import EventEmitter from 'events';
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

export type NotifierSendMessageCallback = (body: SendGridMailWithTemplateId, description: string) => Promise<void>;

/**
 * A notifier that sends no messages, and is sufficient only for unsubscribing/removing a user.
 */
export class UnsubscribeNotifier extends BaseNotifier {
  protected _testSendMessageCallback?: NotifierSendMessageCallback;
  protected readonly _sendGridKey: string|undefined =
    appSettings.section('notifications').flag('sendGridKey')
    .readString({envVar: 'SENDGRID_API_KEY', censor: true});

  public constructor(protected _dbManager: HomeDBManager, protected _sendgridConfig: SendGridConfig) {
    super();
  }

  public override async deleteUser(userId: number) {
    if (!this._sendGridKey) {
      log.warn(`API key not set, cannot delete user ${userId} from sendgrid`);
      return;
    }
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

  public testSendGridExtensions() {
    return this;
  }

  // for test purposes, override sendMessage
  public setSendMessageCallback(op: (body: SendGridMailWithTemplateId, description: string) => Promise<void>) {
    this._testSendMessageCallback = op;
  }

  public getConfig() {
    return SENDGRID_CONFIG;
  }

  /**
   * Call node-fetch, with the path prefixed appropriately, any variables expanded,
   * necessary headers added, and body stringified.  TODO: This would be a good place to
   * add retries.
   */
  protected async _fetch(path: string, options: {method: string, body?: any}) {
    if (!this._sendGridKey) { throw new Error('sendgrid not available'); }
    const headers = {
      'Authorization': `Bearer ${this._sendGridKey}`,
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
}


/**
 * Manager for sending notifications to users about resources they've been invited to.
 * Has access to the database so that it can look up everything it needs to know about
 * for describing users, and it knows the home url so that it can construct links for
 * resources.
 */
export class Notifier extends UnsubscribeNotifier implements INotifier {
  private _gristConfig: GristLoadConfig;
  private _tools: NotifierTools;

  public constructor(
    protected _dbManager: HomeDBManager,
    _gristServer: GristServer,
    protected _sendgridConfig: SendGridConfig,
  ) {
    super(_dbManager, _sendgridConfig);
    this._gristConfig = _gristServer.getGristConfig();
    if (!this._gristConfig.homeUrl) { throw new Error('Notifier requires a home URL'); }
    this._tools = new NotifierTools(
      _gristServer,
      _dbManager, {
        unsubscribeGroup: this._sendgridConfig.unsubscribeGroup,
        address: this._sendgridConfig.address,
      }
    );
  }

  public subscribe(emitter: EventEmitter): void {
    for (const method of NotifierEvents.values) {
      emitter.on(method, (...args) => (this[method] as any)(...args));
    }
  }

  public async applyTemplate(templateId: string, mail: Mailer<SendGridMail>) {
    await this._tools.runLogging(mail.logging);
    if (mail.content) {
      await this.sendMessage({
        ...mail.content,
        template_id: templateId,
      }, mail.label);
    }
  }

  /**
   * Send an email to a user, if the sendgrid api is available (requires SENDGRID_API_KEY).
   * @param payload: body of message, in the format sendgrid expects
   * @param description: a short summary of email for use in log messages
   */
  public async sendMessage(body: SendGridMailWithTemplateId, description: string) {
    if (this._testSendMessageCallback) {
      return this._testSendMessageCallback(body, description);
    }
    if (!this._sendGridKey) {
      log.debug(`sendgrid skipped: ${description}`);
      return;
    }
    const response = await this._fetch(SENDGRID_API_CONFIG.send, {
      method: 'POST',
      body: {
        // Disable click-tracking for transactional emails. It's not helpful to us, and for users,
        // it reduces privacy and obscures URLs.
        tracking_settings: {
          click_tracking: {enable: false, enable_text: false},
          open_tracking: {enable: false},
        },
        ...body
      }
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
    if (!this._sendGridKey) {
      log.debug(`sendgrid skipped: ${description}`);
      return;
    }
    log.debug(`sendgrid contact info: ${JSON.stringify(body)}`);
    const response = await this._fetch(SENDGRID_API_CONFIG.enroll, {
      method: 'PUT',
      body,
    });
    if (!response.ok) {
      log.error(`sendgrid error ${response.status} ${response.statusText}: ${description}`);
    } else {
      const reply = await response.json();
      log.debug(`sendgrid sent: ${description}, response ${JSON.stringify(reply)}`);
    }
  }

  /**
   * Handler for addUser events.  This gets called when a PATCH is made to an /access endpoint.
   * It is called with a pre-existing list of members, and the requested changes.
   */
  public async addUser(userId: number, resource: Organization|Workspace|Document,
                       delta: UserIdDelta, membersBefore: Map<roles.NonGuestRole, User[]>) {
    const templateId = this._getTemplateId('invite');
    if (!templateId) { return; }
    const mail = await this._tools.addUser(userId, resource, delta, membersBefore);
    await this.applyTemplate(templateId, mail);
    for (const user of mail.invitedUsers || []) {
      // some users may need to be switched over to team onboarding list.
      await this._updateList(user);
    }
  }

  /**
   * Handler for addBillingManager events.  This gets called when a PATCH is made to the
   * /billing/managers endpoint.
   */
  public async addBillingManager(hostUserId: number, addUserId: number, orgs: Organization[]) {
    const templateId = this._getTemplateId('billingManagerInvite');
    if (!templateId) { return; }
    const mail = await this._tools.addBillingManager(hostUserId, addUserId, orgs);
    await this.applyTemplate(templateId, mail);
  }

  /**
   * Handler for firstLogin events.  Adds user to an onboarding in sendgrid.
   * We wait until this point so we have the user's name, not just email address.
   */
  public async firstLogin(user: FullUser) {
    await this._updateList(user, true);
  }

  /**
   * Handler for teamCreator events, emitted when a user creates a team.
   */
  public async teamCreator(userId: number) {
    const user = await this._dbManager.getFullUser(userId);
    // Make sure user is on all the lists they merit being on, if we know their name
    // already.
    if (user.name) {
      await this._updateList(user, true);
    }
  }

  /**
   * Handler for userChange events.  Notifies billing managers when users are added or
   * removed from organization.
   */
  public async userChange(change: UserChange) {
    const templateId = this._getTemplateId('memberChange');
    if (!templateId) { return; }
    const mail = await this._tools.userChange(change);
    await this.applyTemplate(templateId, mail);
  }

  /**
   * Send email to billing managers when Stripe warns us that a trial period is ending
   * soon.  Provides a link to billing page where details can be checked and action taken.
   */
  public async trialPeriodEndingSoon(
    account: BillingAccount,
    subscription: {trial_end: number | null}
  ) {
    const templateId = this._getTemplateId('trialPeriodEndingSoon');
    if (!templateId) { return; }
    const mail = await this._tools.trialPeriodEndingSoon(account, subscription);
    await this.applyTemplate(templateId, mail);
  }

  /**
   * Called when an account enters trial mode. Puts billing managers
   * in a special trial list in sendgrid.
   */
  public async trialingSubscription(account: BillingAccount) {
    const trialListId = this._sendgridConfig.list.trial;
    if (!trialListId) { return; }
    const fullAccount = await this._dbManager.getFullBillingAccount(account.id);
    const managers = this._getManagers(fullAccount);
    await Promise.all(managers.map(
      manager => this._addOrUpdateContact(manager, {listIds: [trialListId]})
    ));
  }

  /**
   * Called when a user schedules a call. Sets the call_scheduled custom
   * field in sendgrid for that user.
   */
  public async scheduledCall(userRef: string) {
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
  }

  /**
   * Handler for 2FA events. Notifies the user when two-factor authentication config is changed
   * for their account.
   */
  public async twoFactorStatusChanged(event: TwoFactorEvent, userId: number, method?: 'TOTP' | 'SMS') {
    const templateId = this._getTemplateId(event);
    if (!templateId) { return; }
    const mail = await this._tools.twoFactorStatusChanged(event, userId, method);
    await this.applyTemplate(templateId, mail);
  }

  /**
   * Handler for document notifications, including docChange and comment events.
   */
  public async docNotification(
    event: DocNotificationEvent, userId: number, templateData: DocNotificationTemplateBase
  ): Promise<void> {
    const templateId = this._getTemplateId(event);
    if (!templateId) { return; }
    const mail = await this._tools.docNotification(event, userId, templateData);
    await this.applyTemplate(templateId, mail);
  }

  private _getTemplateId(type: keyof SendGridConfig['template']) {
    const templateId = this._sendgridConfig.template[type];
      if (!templateId) {
        log.error(`skipped notification with no template for event: ${type}`);
        return;
      }
    return templateId;
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
    if (!this._sendGridKey) {
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
    const contact: SendGridContact['contacts'][number] = {
      email: normalizeEmail(user.email), // don't want to send multiple emails to same mailbox
      first_name: first.substr(0, 50),   // this is max length for this field in sendgrid
      last_name: last.substr(0, 50)      // this is max length for this field in sendgrid
    };
    const description = `enrollment for ${user.email} with options ${JSON.stringify(options)}`;
    const customFields: Record<string, any> = {};
    if (options.customFields?.callScheduled && this._sendgridConfig.field?.callScheduled) {
      customFields[this._sendgridConfig.field.callScheduled] = options.customFields.callScheduled;
    }
    if (this._sendgridConfig.field?.userRef) {
      customFields[this._sendgridConfig.field.userRef] = user.ref;
    }
    if (Object.keys(customFields).length) {
      contact.custom_fields = customFields;
    }
    await this.sendContactInfo({
      ...(options.listIds && { list_ids: options.listIds }),
      contacts: [contact]
    }, description);
  }

  /**
   * Compile a list of billing managers in a format compatible with SendGrid api.
   */
  private _getManagers(account: BillingAccount): FullUser[] {
    // TODO: correct typing on account managers.
    return account.managers as any[] as FullUser[];
  }
}
