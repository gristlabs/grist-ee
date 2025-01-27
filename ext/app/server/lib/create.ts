import { Activation } from 'app/gen-server/lib/Activation';
import { configureSendGridNotifier } from 'app/gen-server/lib/configureSendGridNotifier';
import { checkAzureExternalStorage, configureAzureExternalStorage } from 'app/server/lib/configureAzureExternalStorage';
import { configureEnterpriseAuditLogger } from 'app/server/lib/configureEnterpriseAuditLogger';
import { checkMinIOExternalStorage, configureMinIOExternalStorage } from 'app/server/lib/configureMinIOExternalStorage';
import { checkS3ExternalStorage, configureS3ExternalStorage } from 'app/server/lib/configureS3ExternalStorage';
import { IBilling } from 'app/server/lib/IBilling';
import { BaseCreate, ICreate, ICreateStorageOptions } from 'app/server/lib/ICreate';
import { isRunningEnterprise } from 'app/server/lib/ActivationReader';
import { CoreCreate } from 'app/server/lib/coreCreator';
import { getLoginSystem } from "app/server/lib/logins";
import {EmptyNotifier, INotifier} from 'app/server/lib/INotifier';
import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {GristLoginSystem, GristServer} from 'app/server/lib/GristServer';


class EnterpriseCreate extends BaseCreate {
  constructor() {
    const storage: ICreateStorageOptions[] = [
      {
        name: 'azure',
        check: () => checkAzureExternalStorage() !== undefined,
        create: configureAzureExternalStorage,
      },
      {
        name: 's3',
        check: () => checkS3ExternalStorage() !== undefined,
        create: configureS3ExternalStorage,
      },
      {
        name: 'minio',
        check: () => checkMinIOExternalStorage() !== undefined,
        create: configureMinIOExternalStorage,
      },
    ];
    super('enterprise', storage);
  }

  public override Billing(dbManager: HomeDBManager, gristServer: GristServer): IBilling {
    return new Activation(dbManager, gristServer);
  }
  public override Notifier(dbManager: HomeDBManager, gristServer: GristServer): INotifier {
    return configureSendGridNotifier(dbManager, gristServer) || EmptyNotifier;
  }
  public override AuditLogger(dbManager: HomeDBManager, gristServer: GristServer) {
    return configureEnterpriseAuditLogger(dbManager, gristServer);
  }
  public override getLoginSystem(): Promise<GristLoginSystem> {
    return getLoginSystem();
  }
}

export const create: ICreate = isRunningEnterprise() ? new EnterpriseCreate() : new CoreCreate();
