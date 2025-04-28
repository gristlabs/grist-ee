import log from 'app/server/lib/log';
import { EventName, TemplateName } from 'app/server/lib/INotifier';
import { Mailer, NotifierBase, NotifierConfig } from 'app/gen-server/lib/NotifierTools';
import { DynamicTemplateData, SendGridMail } from 'app/gen-server/lib/NotifierTypes';

import * as fse from 'fs-extra';
import * as nodemailer from 'nodemailer';
import * as handlebars from 'handlebars';

interface CompiledTemplates<T>{
  subjectTemplate: HandlebarsTemplateDelegate<T>;
  txtTemplate: HandlebarsTemplateDelegate<T>;
  htmlTemplate: HandlebarsTemplateDelegate<T>;
}

export class SMTPNotifier extends NotifierBase {
  private _templates: { [Key in TemplateName as string]: CompiledTemplates<DynamicTemplateData> };
  private _transporter: nodemailer.Transporter;

  constructor(smtpConfig: nodemailer.TransportOptions, config: NotifierConfig) {
    super(config);
    this._initTemplates();
    this._initTransport(smtpConfig);
  }

  public async applyNotification(eventName: EventName, mail: Mailer<SendGridMail>) {
    const eventTemplateNames = {
      addUser: "invite",
      addBillingManager: "billingManagerInvite",
      userChange: "memberChange",
      trialPeriodEndingSoon: "trialPeriodEndingSoon",
      deleteUser: undefined,
      firstLogin: undefined,
      teamCreator: undefined,
      trialingSubscription: undefined,
      scheduledCall: undefined,
      streamingDestinationsChange: undefined,
      twoFactorStatusChanged: undefined,
      testSendGridExtensions: undefined,
    };

    let templateName: string | undefined;
    if (eventName === "twoFactorStatusChanged") {
      templateName = mail.content?.template_name;
    }
    templateName = eventTemplateNames[eventName];
    if (!templateName) {
      // Don't have a template for this event, send no emails
      return;
    }

    const {subjectTemplate, txtTemplate, htmlTemplate} = this._templates[templateName];

    if (mail.content) {
      for(const personalization of mail.content.personalizations) {
        const {to, dynamic_template_data} = personalization;
        const toField = to.map(person => `${person.name} <${person.email}>`).join(', ');
        const replyTo = mail.content?.reply_to ?
          `${mail.content.reply_to.name} <${mail.content.reply_to.email}>`: undefined;
        const fromField = mail.content?.from ?
          `${mail.content.from.name} <${mail.content.from.email}>`: undefined;

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
    }
  }

  private _initTemplates() {
    const templatePath = 'ext/assets/email-templates';
    const subjectTemplates = {
      billingManagerInvite: "Grist invite to {{{ resource.name }}}",
      invite: "Grist invite to {{{ resource.name }}}",
      memberChange: "Membership has changed for {{org.name}}",
      trialPeriodEndingSoon: "Grist trial period ending soon",
      twoFactorDisabled: "Two-factor authentication disabled",
      twoFactorEnabled: "Two-factor authentication enabled",
      twoFactorMethodAdded: "2FA Method Added",
      twoFactorMethodRemoved: "2FA Method Removed",
      twoFactorPhoneNumberChanged: "Phone number changed",
    };
    this._templates = {};
    for(const templateName of TemplateName.values) {
      const subjectTemplate = handlebars.compile(subjectTemplates[templateName]);
      const txtTemplate = handlebars.compile(
        fse.readFileSync(`${templatePath}/${templateName}.txt`)
          .toString()
      );
      const htmlTemplate = handlebars.compile(
        fse.readFileSync(`${templatePath}/${templateName}.html`)
          .toString()
      );
      this._templates[templateName] = {subjectTemplate, txtTemplate, htmlTemplate};
    }
  }

  private _initTransport(smtpConfig: nodemailer.TransportOptions) {
    this._transporter = nodemailer.createTransport(smtpConfig);
    this._transporter.verify().then(() => {
      const name = this._transporter.transporter.name;
      log.info(`SMTPNotifier: initialized new transport of type ${name}`);
    }).catch((err) => {
      log.error('SMTPNotifier: error initializing');
      log.error(`SMTPNotifier: ${err}`);
    });
  }
}
