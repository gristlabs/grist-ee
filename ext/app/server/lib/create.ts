import {isAffirmative} from 'app/common/gutil';
import { Activation } from 'app/gen-server/lib/Activation';
import { addAdminControlsEndpoints } from 'app/gen-server/lib/AdminControls';
import { configureSendGridNotifier } from 'app/gen-server/lib/configureSendGridNotifier';
import { configureSMTPNotifier } from 'app/gen-server/lib/configureSMTPNotifier';
import { configureTestNotifier } from 'app/gen-server/lib/configureTestNotifier';
import {NotificationsConfig} from 'app/gen-server/lib/NotificationsConfig';
import { configureAssistant } from 'app/server/lib/configureAssistant';
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
import {Express} from 'express';


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
    return configureSMTPNotifier(dbManager, gristServer) ||
      configureTestNotifier(dbManager, gristServer) ||
      configureSendGridNotifier(dbManager, gristServer) ||
      EmptyNotifier;
  }
  public override AuditLogger(dbManager: HomeDBManager, gristServer: GristServer) {
    return configureEnterpriseAuditLogger(dbManager, gristServer);
  }
  public override Assistant() {
    return configureAssistant();
  }
  public override getLoginSystem(): Promise<GristLoginSystem> {
    return getLoginSystem();
  }
  public override addExtraHomeEndpoints(gristServer: GristServer, app: Express): void {
    if (isAffirmative(process.env.GRIST_TEST_ENABLE_NOTIFICATIONS)) {
      NotificationsConfig.addEndpoints(gristServer.getHomeDBManager(), app);
    }
    addAdminControlsEndpoints(gristServer.getHomeDBManager(), gristServer, app);
  }
  public override areAdminControlsAvailable(): boolean { return true; }
}

export const create: ICreate = isRunningEnterprise() ? new EnterpriseCreate() : new CoreCreate();
