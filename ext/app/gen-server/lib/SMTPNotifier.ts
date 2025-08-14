import { appSettings } from 'app/server/lib/AppSettings';
import log from 'app/server/lib/log';
import { getAppPathTo, getAppRoot } from 'app/server/lib/places';
import { Mailer, NotifierBase, NotifierConfig } from 'app/gen-server/lib/NotifierTools';
import {
  DocNotificationEvent, DynamicTemplateData, NotifierEventName,
  SendGridAddress, SendGridMail, TemplateName, TwoFactorEvent,
} from 'app/gen-server/lib/NotifierTypes';

// This import runs code to register a few extra Handlebars helpers
// needed for parity with the template features we use with SendGrid.
import 'app/gen-server/lib/HandlebarsHelpers';

import * as fse from 'fs-extra';
import * as nodemailer from 'nodemailer';
import * as handlebars from 'handlebars';

interface CompiledTemplates<T>{
  subjectTemplate: HandlebarsTemplateDelegate<T>;
  txtTemplate: HandlebarsTemplateDelegate<T>;
  htmlTemplate: HandlebarsTemplateDelegate<T>;
}

function getTemplateName(eventName: NotifierEventName, arg: unknown): TemplateName|undefined {
  switch (eventName) {
    case 'addUser': return "invite";
    case 'addBillingManager': return "billingManagerInvite";
    case 'userChange': return "memberChange";
    case 'trialPeriodEndingSoon': return "trialPeriodEndingSoon";
    case 'twoFactorStatusChanged': return arg as TwoFactorEvent;
    case 'docNotification': return arg as DocNotificationEvent;
  }
}

export class SMTPNotifier extends NotifierBase {
  private _templates: { [Key in TemplateName as string]: CompiledTemplates<DynamicTemplateData> };
  private _transporter: nodemailer.Transporter;
  private _configurationWorks: Promise<boolean>;

  constructor(smtpConfig: nodemailer.TransportOptions, config: NotifierConfig) {
    super(config);
    this._initTemplates();
    this._configurationWorks = this._initTransport(smtpConfig);
  }

  public async applyNotification(eventName: NotifierEventName, mail: Mailer<SendGridMail>,
                                 notificationArgs: unknown[]) {
    if (! await this._configurationWorks) {
      // We have no working configuration, attempt no emails.
      return;
    }

    // For the 2FA event, there is a further subtype passed in as the
    // first argument of the notification function. That argument is
    // both the event name and the template name.
    const templateName = getTemplateName(eventName, notificationArgs[0]);
    if (!templateName) {
      log.debug(`SMTPNotifier: no template for event ${eventName}, sending no emails`);
      return;
    }

    const {subjectTemplate, txtTemplate, htmlTemplate} = this._templates[templateName];
    if (mail.content) {
      for(const personalization of mail.content.personalizations) {
        const {to, dynamic_template_data} = personalization;
        const toField = to.map(gristPersonToAddress);
        const replyTo = mail.content?.reply_to ? gristPersonToAddress(mail.content.reply_to) : undefined;
        const fromField = mail.content?.from ? gristPersonToAddress(mail.content.from) : undefined;

        const info = await this._transporter.sendMail({
          to: toField,
          from: fromField,
          replyTo: replyTo,
          subject: subjectTemplate(dynamic_template_data),
          text: txtTemplate(dynamic_template_data),
          html: htmlTemplate(dynamic_template_data),
        });
        log.debug('SMTPNotifier: sent notification', info);
      }
    } else {
      log.warn(`SMTPNotifier: no content to send for event ${eventName}, skipping email`);
    }
  }

  private _initTemplates() {
    const templatePath = appSettings.section("notifications").flag("templatesDir").readString({
      envVar: "GRIST_SMTP_TEMPLATES_DIR",
      defaultValue: getAppPathTo(getAppRoot(), 'ext/assets/email-templates'),
    });

    const subjectTemplates: Record<TemplateName, string> = {
      billingManagerInvite: "Grist invite to {{{ resource.name }}}",
      invite: "Grist invite to {{{ resource.name }}}",
      memberChange: "Membership has changed for {{org.name}}",
      trialPeriodEndingSoon: "Grist trial period ending soon",
      twoFactorDisabled: "Two-factor authentication disabled",
      twoFactorEnabled: "Two-factor authentication enabled",
      twoFactorMethodAdded: "2FA Method Added",
      twoFactorMethodRemoved: "2FA Method Removed",
      twoFactorPhoneNumberChanged: "Phone number changed",
      docChanges: "Updates to {{{ docName }}}",
      comments: "New comments in {{{ docName }}}",
    };
    this._templates = {};
    for(const templateName of TemplateName.values) {
      const subjectTemplate = handlebars.compile(subjectTemplates[templateName]);
      const txtTemplate = handlebars.compile(
        fse.readFileSync(`${templatePath}/${templateName}.txt`, 'utf8')
      );
      const htmlTemplate = handlebars.compile(
        fse.readFileSync(`${templatePath}/${templateName}.html`, 'utf8')
      );
      this._templates[templateName] = {subjectTemplate, txtTemplate, htmlTemplate};
    }
  }

  private async _initTransport(smtpConfig: nodemailer.TransportOptions) {
    this._transporter = nodemailer.createTransport(smtpConfig);
    try {
      await this._transporter.verify();
      const name = this._transporter.transporter.name;
      log.info(`SMTPNotifier: initialized new transport of type ${name}`);
      return true;
    } catch(err)  {
      log.error('SMTPNotifier: during initialization:', err);
      return false;
    }
  }
}

function gristPersonToAddress(person: SendGridAddress) {
  return { name: person.name, address: person.email};
}
