import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {TestNotifier} from 'app/gen-server/lib/TestNotifier';
import {GristServer} from 'app/server/lib/GristServer';

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
