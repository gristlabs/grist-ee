import { Activation } from 'app/gen-server/lib/Activation';
import { configureSendGridNotifier } from 'app/gen-server/lib/configureSendGridNotifier';
import { checkAzureExternalStorage, configureAzureExternalStorage } from 'app/server/lib/configureAzureExternalStorage';
import { configureEnterpriseAuditLogger } from 'app/server/lib/configureEnterpriseAuditLogger';
import { checkMinIOExternalStorage, configureMinIOExternalStorage } from 'app/server/lib/configureMinIOExternalStorage';
import { checkS3ExternalStorage, configureS3ExternalStorage } from 'app/server/lib/configureS3ExternalStorage';
import { ICreate, makeSimpleCreator } from 'app/server/lib/ICreate';
import { isRunningEnterprise } from 'app/server/lib/ActivationReader';
import { makeCoreCreator } from 'app/server/lib/coreCreator';
import { getLoginSystem } from "app/server/lib/logins";

export const makeEnterpriseCreator = () => makeSimpleCreator({
  deploymentType: 'enterprise',
  storage: [
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
  ],
  billing: {
    create: (dbManager, gristConfig) => new Activation(dbManager, gristConfig),
  },
  notifier: {
    create: configureSendGridNotifier,
  },
  auditLogger: {
    create: configureEnterpriseAuditLogger,
  },
  getLoginSystem,
});

export const create = isRunningEnterprise() ? makeEnterpriseCreator() : makeCoreCreator();

export function getCreator(): ICreate {
  return create;
}
