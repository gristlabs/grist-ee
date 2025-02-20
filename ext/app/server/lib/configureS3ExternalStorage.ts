import {appSettings} from 'app/server/lib/AppSettings';
import {wrapWithKeyMappedStorage} from 'app/server/lib/ExternalStorage';
import {S3ExternalStorage} from 'app/server/lib/S3ExternalStorage';

export function configureS3ExternalStorage(purpose: 'doc'|'meta'|'attachments', extraPrefix: string) {
  // Check S3 configuration.
  // We choose to use the same bucket for document and meta storage, but that
  // could change in future.
  const options = checkS3ExternalStorage();
  if (!options) {
    // No store - this can happen in tests.
    return undefined;
  }
  const {bucket, prefix} = options;
  return wrapWithKeyMappedStorage(new S3ExternalStorage(bucket), {
    basePrefix: prefix,
    extraPrefix,
    purpose,
  });
}

export function checkS3ExternalStorage() {
  const settings = appSettings.section('externalStorage').section('s3');
  const bucket = settings.flag('bucket').readString({
    envVar: ['TEST_S3_BUCKET', 'GRIST_DOCS_S3_BUCKET'],
    preferredEnvVar: 'GRIST_DOCS_S3_BUCKET',
  });
  if (!bucket) { return undefined; }
  const prefix = settings.flag('prefix').requireString({
    envVar: ['TEST_S3_PREFIX', 'GRIST_DOCS_S3_PREFIX'],
    preferredEnvVar: 'GRIST_DOCS_S3_PREFIX',
    defaultValue: 'docs/',
  });
  settings.flag('url').set(`s3://${bucket}/${prefix}`);
  settings.flag('active').set(true);
  return {
    bucket, prefix,
  };
}
