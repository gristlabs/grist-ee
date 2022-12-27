import { appSettings } from "app/server/lib/AppSettings";
import { AzureExternalStorage } from "app/server/lib/AzureExternalStorage";
import { wrapWithKeyMappedStorage } from "app/server/lib/ExternalStorage";

export function configureAzureExternalStorage(purpose: 'doc'|'meta', extraPrefix: string) {
  const options = checkAzureExternalStorage();
  if (!options?.bucket) { return undefined; }
  return wrapWithKeyMappedStorage(new AzureExternalStorage(options.bucket), {
    basePrefix: options.prefix,
    extraPrefix,
    purpose,
  });
}

export function checkAzureExternalStorage() {
  const settings = appSettings.section('externalStorage').section('azure');
  if (settings.flag('connection').readString({
    envVar: 'AZURE_STORAGE_CONNECTION_STRING',
    censor: true,
  }) === undefined) {
    return undefined;
  }
  // For compatibility with existing tests, ignore Azure if no bucket is set.
  const bucket = settings.flag('container').readString({
   envVar: ['GRIST_AZURE_CONTAINER', 'TEST_S3_BUCKET', 'GRIST_DOCS_S3_BUCKET'],
  });
  if (bucket === undefined) { return undefined; }
  const prefix = settings.flag('prefix').requireString({
    envVar: ['GRIST_AZURE_PREFIX', 'TEST_S3_PREFIX', 'GRIST_DOCS_S3_PREFIX'],
    defaultValue: 'docs/',
  });
  settings.flag('active').set(true);
  return {
    bucket, prefix,
  };
}
