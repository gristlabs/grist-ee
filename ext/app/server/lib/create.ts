import {Activation} from 'app/gen-server/lib/Activation';
import {addAdminControlsEndpoints} from 'app/gen-server/lib/AdminControls';
import {configureSendGridNotifier} from 'app/gen-server/lib/configureSendGridNotifier';
import {configureSMTPNotifier} from 'app/gen-server/lib/configureSMTPNotifier';
import {createDocNotificationManager} from 'app/gen-server/lib/DocNotificationManager';
import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {configureTestNotifier} from 'app/gen-server/lib/TestNotifier';
import {isRunningEnterprise} from 'app/server/lib/ActivationReader';
import {configureAssistant} from 'app/server/lib/configureAssistant';
import {checkAzureExternalStorage, configureAzureExternalStorage} from 'app/server/lib/configureAzureExternalStorage';
import {configureEnterpriseAuditLogger} from 'app/server/lib/configureEnterpriseAuditLogger';
import {checkMinIOExternalStorage, configureMinIOExternalStorage} from 'app/server/lib/configureMinIOExternalStorage';
import {checkS3ExternalStorage, configureS3ExternalStorage} from 'app/server/lib/configureS3ExternalStorage';
import {CoreCreate} from 'app/server/lib/coreCreator';
import {getExtLoginSystem} from 'app/server/lib/extLogins';
import {GristLoginSystem, GristServer} from 'app/server/lib/GristServer';
import {IBilling} from 'app/server/lib/IBilling';
import {BaseCreate, ICreate, ICreateStorageOptions} from 'app/server/lib/ICreate';
import {INotifier} from 'app/server/lib/INotifier';
import {InstallAdmin} from 'app/server/lib/InstallAdmin';
import {createInstallAdminUsingOrg} from 'app/server/lib/InstallAdminUsingOrg';
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
  public override Notifier(dbManager: HomeDBManager, gristServer: GristServer): INotifier|undefined {
    return configureSMTPNotifier(dbManager, gristServer) ||
      configureTestNotifier(dbManager, gristServer) ||
      configureSendGridNotifier(dbManager, gristServer);
  }
  public override AuditLogger(dbManager: HomeDBManager, gristServer: GristServer) {
    return configureEnterpriseAuditLogger(dbManager, gristServer);
  }
  public override Assistant(gristServer: GristServer) {
    return configureAssistant(gristServer);
  }
  public override async createInstallAdmin(dbManager: HomeDBManager): Promise<InstallAdmin> {
    return createInstallAdminUsingOrg(dbManager);
  }
  public override getLoginSystem(dbManager: HomeDBManager): Promise<GristLoginSystem> {
    return getExtLoginSystem(dbManager.getAppSettings());
  }
  public override addExtraHomeEndpoints(gristServer: GristServer, app: Express): void {
    addAdminControlsEndpoints(gristServer.getHomeDBManager(), gristServer, app);
  }
  public override areAdminControlsAvailable(): boolean { return true; }
  public override createDocNotificationManager(gristServer: GristServer) {
    return createDocNotificationManager(gristServer);
  }
}

export const create: ICreate = isRunningEnterprise() ? new EnterpriseCreate() : new CoreCreate();
