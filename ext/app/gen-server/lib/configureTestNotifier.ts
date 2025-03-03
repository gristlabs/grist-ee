import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {TestNotifier} from 'app/gen-server/lib/TestNotifier';
import {GristServer} from 'app/server/lib/GristServer';

export function configureTestNotifier(dbManager: HomeDBManager, gristServer: GristServer) {
  if (process.env.GRIST_NOTIFIER !== 'test') { return undefined; }
  return new TestNotifier({
    dbManager, gristServer, options: {
      address: {
        from: {
          email: 'support@getgrist.com',
          name: 'Grist',
        }
      }
    }
  });
}
