import { GristServer } from 'app/server/lib/GristServer';
import { HomeDBManager } from 'app/gen-server/lib/homedb/HomeDBManager';
import { INotifier } from 'app/server/lib/INotifier';
import { Mailer, NotifierBase } from 'app/gen-server/lib/NotifierTools';
import { SendGridMail } from 'app/gen-server/lib/NotifierTypes';

export function configureTestNotifier(dbManager: HomeDBManager, gristServer: GristServer) {
  if (process.env.GRIST_NOTIFIER !== 'test') { return undefined; }
  return new TestNotifier({
    dbManager, gristServer, options: {
      address: {
        from: { name: 'Grist', email: 'support@getgrist.com' },
        docNotificationsFrom: { name: 'Grist Test', email: 'support-notifications@getgrist.com' },
        docNotificationsReplyTo: { name: 'Grist Test', email: 'support-no-reply@getgrist.com' },
      }
    }
  });
}

/**
 *
 * A minimal implementation of the INotifier interface that just
 * outputs the event, enriched using the NotifierTools, onto the
 * console. Activated by setting GRIST_NOTIFIER to `test`.
 *
 * This class is exported for use in tests.
 */
export class TestNotifier extends NotifierBase {
  public async applyNotification(eventName: keyof INotifier, mail: Mailer<SendGridMail>) {
    console.log(JSON.stringify({notification: 'test', eventName, mail}));
  }
}
