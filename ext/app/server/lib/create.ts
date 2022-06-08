import { configureSendGridNotifier } from 'app/gen-server/lib/configureSendGridNotifier';
import { addActivationMiddleware } from 'app/server/lib/ActivationReader';
import { makeSimpleCreator } from 'app/server/lib/ICreate';
import { checkAzureExternalStorage,
         configureAzureExternalStorage } from 'app/server/lib/configureAzureExternalStorage';
import { checkS3ExternalStorage,
         configureS3ExternalStorage } from 'app/server/lib/configureS3ExternalStorage';

export const create = makeSimpleCreator({
  storage: [
    {
      check: () => checkAzureExternalStorage() !== undefined,
      create: configureAzureExternalStorage,
    },
    {
      check: () => checkS3ExternalStorage() !== undefined,
      create: configureS3ExternalStorage,
    },
  ],
  activationMiddleware: addActivationMiddleware,
  notifier: {
    create: configureSendGridNotifier,
  },
});
