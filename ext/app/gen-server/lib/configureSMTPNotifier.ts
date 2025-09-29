/**
 * Grist sends emails when a user is invited to a document or receives a document notification. It
 * uses Nodemailer for this purpose. It relies on these environment variables:
 *
 * - GRIST_NODEMAILER_CONFIG:
 *    JSON configuration string passed verbatim to Nodemailer’s createTransport method. See
 *    https://nodemailer.com/usage#create-a-transporter.
 * - GRIST_NODEMAILER_SENDER:
 *    JSON configuration string for setting the "From" fields of emails sent by Grist. It takes the
 *    following form:
 *    {
 *      "name": "Default Name Of Sender",
 *      "email": "sender.email@example.com",
 *
 *      // Also, optionally:
 *      "docNotificationsFrom": "notifications@example.com",
 *      "docNotificationsReplyTo": "no-reply@example.com",
 *    }
 *
 *    The "docNotifications*" fields allow overriding From and ReplyTo for notifications.
 *    Notifications "From" address is visible to users but isn't used for replies. It could be
 *    the same as your support inbox, or an alias to it. "ReplyTo" is used for replies. There is
 *    no support for replying to comments by email; a "no-reply" address makes that clearer.
 *
 *    If "docNotificationsFrom" is omitted, it defaults to the default sender email.
 *    If "docNotificationsReplyTo" is omitted, it defaults to docNotificationsFrom.
 */
import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {Address, NodemailerSender} from 'app/gen-server/lib/NodemailerConfig';
import NodemailerConfigTI from 'app/gen-server/lib/NodemailerConfig-ti';
import {NotifierToolsOptions} from 'app/gen-server/lib/NotifierTools';
import {SMTPNotifier} from 'app/gen-server/lib/SMTPNotifier';
import {appSettings} from 'app/server/lib/AppSettings';
import {GristServer} from 'app/server/lib/GristServer';
import log from 'app/server/lib/log';

import {TransportOptions} from 'nodemailer';
import * as t from 'ts-interface-checker';

const { NodemailerSender } = t.createCheckers(NodemailerConfigTI);

export function configureSMTPNotifier(dbManager: HomeDBManager, gristServer: GristServer) {
  if (!process.env.GRIST_NODEMAILER_SENDER || !process.env.GRIST_NODEMAILER_CONFIG) {
    return undefined;
  }
  try{
    // e.g. {"name": "Chimpy", "email": "chimpy@getgrist.com"}
    const smtpSender = parseSender(
      appSettings.section("notifications").flag("nodemailerSender").requireString({
        envVar: 'GRIST_NODEMAILER_SENDER'
      }),
      'GRIST_NODEMAILER_SENDER',
    );
    // The SMTPNotifier class will verify itself if this JSON config
    // works for Nodemailer. See Nodemailer's transport docs:
    // https://nodemailer.com/transports/
    const smtpConfig = JSON.parse(
      appSettings.section("notifications").flag("nodemailerConfig").requireString({
        envVar: 'GRIST_NODEMAILER_CONFIG',
        censor: true,
      })
    ) as TransportOptions;

    return new SMTPNotifier(smtpConfig, {
      dbManager, gristServer, options: {address: smtpSender}
    });
  } catch (err) {
    log.error(`SMTPNotifier: error initializing, verify configuration: ${err}`);
    throw new Error(`SMTPNotifier: ${err.message}`);
  }
}


function checkNodemailerSender(value: unknown): asserts value is NodemailerSender {
  NodemailerSender.setReportedPath('');
  NodemailerSender.check(value);
}

function parseSender(senderConfigJson: string, envVar: string): NotifierToolsOptions["address"] {
  try {
    const senderConfig = JSON.parse(senderConfigJson) as unknown;
    checkNodemailerSender(senderConfig);
    const {name, email} = senderConfig;
    const from: Address = {name, email};
    const docNotificationsFrom = senderConfig.docNotificationsFrom || from.email;
    const docNotificationsReplyTo = senderConfig.docNotificationsReplyTo || docNotificationsFrom;
    return {
      from,
      docNotificationsFrom: {name: from.name, email: docNotificationsFrom},
      docNotificationsReplyTo: {name: from.name, email: docNotificationsReplyTo},
    };
  } catch (e) {
    throw new Error(`${envVar}: ${e.message}`);
  }
}
