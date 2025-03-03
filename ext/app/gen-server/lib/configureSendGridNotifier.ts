import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {Notifier} from 'app/gen-server/lib/Notifier';
import {SendGridConfig} from 'app/gen-server/lib/NotifierTypes';
import {GristServer} from 'app/server/lib/GristServer';

/**
 * Stub SendGrid config. Actual values will be pulled from config.json
 * if available.
 */
export const SENDGRID_CONFIG: SendGridConfig = {
  address: {
    from: {
      email: 'support@example.com',
      name: 'Replace This',
    },
  },
  template: {
    invite: 'sendgrid-template-id',
    billingManagerInvite: 'sendgrid-template-id',
    memberChange: 'sendgrid-template-id',
    trialPeriodEndingSoon: 'sendgrid-template-id',
    twoFactorMethodAdded: 'sendgrid-template-id',
    twoFactorMethodRemoved: 'sendgrid-template-id',
    twoFactorPhoneNumberChanged: 'sendgrid-template-id',
    twoFactorEnabled: 'sendgrid-template-id',
    twoFactorDisabled: 'sendgrid-template-id',
  },
  list: {
    singleUserOnboarding: 'sendgrid-list-id',
    appSumoSignUps: 'sendgrid-list-id-unused',
    trial: 'sendgrid-list-id-unused',
  },
  field: {
    callScheduled: 'xx_N',
    userRef: 'xx_T',
  },
  unsubscribeGroup: {
    invites: 99998,
    billingManagers: 99999,
  },
};

export function configureSendGridNotifier(dbManager: HomeDBManager, gristServer: GristServer) {
  if (!process.env.SENDGRID_API_KEY) { return undefined; }

  /* TODO: this naughty cast is because settings is of type
   * IGristCoreConfig which doesn't have a sendgrid property. Need to
   * properly fix this later.
   */
  const settings = gristServer.settings as any;

  /* Settings are populated from config.json (located in GRIST_INST_DIR).
   *
   * TODO: FlexServer's type for `settings` is an object with unknown values. We should
   * take advantage of ts-interface-checker to make sure config.json has the right shape
   * when read at runtime, instead of unsafely asserting here.
   */
  const sendgridConfig = settings?.sendgrid as SendGridConfig|undefined;
  if (!sendgridConfig) { return undefined; }

  return new Notifier(dbManager, gristServer, sendgridConfig);
}
