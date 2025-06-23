import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {SendGridAddress} from 'app/gen-server/lib/NotifierTypes';
import {SMTPNotifier} from 'app/gen-server/lib/SMTPNotifier';
import {appSettings} from 'app/server/lib/AppSettings';
import {GristServer} from 'app/server/lib/GristServer';
import log from 'app/server/lib/log';

import {TransportOptions} from 'nodemailer';


export function configureSMTPNotifier(dbManager: HomeDBManager, gristServer: GristServer) {
  if ( !process.env.GRIST_NODEMAILER_SENDER || !process.env.GRIST_NODEMAILER_CONFIG) {
    return undefined;
  }
  try{
    // e.g. {"name": "Chimpy", "email": "chimpy@getgrist.com"}
    const smtpSender = parseSender(
      appSettings.section("notifications").flag("nodemailerSender").requireString({
        envVar: 'GRIST_NODEMAILER_SENDER'
      })
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
      dbManager, gristServer, options: {
        address: {
          from: smtpSender
        }
      }
    });
  } catch (err) {
    log.error(`SMTPNotifier: error initializing, verify configuration: ${err}`);
    throw err;
  }
}

function parseSender(sender: string): SendGridAddress {
  const json = JSON.parse(sender);
  for(const key of ["name", "email"]) {
    if(typeof json[key] !== "string") {
      throw new Error(`sender "${key}" key should be a string`);
    }
  }
  return { name: json.name, email: json.email};
}
