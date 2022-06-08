import {HomeDBManager} from 'app/gen-server/lib/HomeDBManager';
import {Notifier, SendGridConfig} from 'app/gen-server/lib/Notifier';
import {GristServer} from 'app/server/lib/GristServer';

export function configureSendGridNotifier(dbManager: HomeDBManager, gristConfig: GristServer) {
  if (!process.env.SENDGRID_API_KEY) { return undefined; }

  /* Settings are populated from config.json (located in GRIST_INST_DIR).
   *
   * TODO: FlexServer's type for `settings` is an object with unknown values. We should
   * take advantage of ts-interface-checker to make sure config.json has the right shape
   * when read at runtime, instead of unsafely asserting here.
   */
  const sendgridConfig = gristConfig.settings?.sendgrid as SendGridConfig|undefined;
  if (!sendgridConfig) { return undefined; }

  return new Notifier(dbManager, gristConfig, sendgridConfig);
}
