import { INotifier } from 'app/server/lib/INotifier';
import { Mailer, NotifierBase } from 'app/gen-server/lib/NotifierTools';
import { SendGridMail } from 'app/gen-server/lib/NotifierTypes';

/**
 *
 * A minimal implementation of the INotifier interface that just
 * outputs the event, enriched using the NotifierTools, onto the
 * console. Activated by setting GRIST_NOTIFIER to `test`.
 *
 */
export class TestNotifier extends NotifierBase {
  public async applyNotification(eventName: keyof INotifier, mail: Mailer<SendGridMail>) {
    console.log(JSON.stringify({notification: 'test', eventName, mail}));
  }
}
