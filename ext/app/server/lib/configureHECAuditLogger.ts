import {HomeDBManager} from 'app/gen-server/lib/homedb/HomeDBManager';
import {appSettings} from 'app/server/lib/AppSettings';
import {HECAuditLogger} from 'app/server/lib/HECAuditLogger';

export function configureHECAuditLogger(db: HomeDBManager) {
  const options = checkHECAuditLogger();
  if (!options) { return undefined; }

  return new HECAuditLogger(db, options);
}

export function checkHECAuditLogger() {
  const settings = appSettings.section('auditLogger').section('http');
  const endpoint = settings.flag('endpoint').readString({
    envVar: 'GRIST_AUDIT_HTTP_ENDPOINT',
  });
  if (!endpoint) { return undefined; }

  const payloadFormat = settings.flag('payloadFormat').readString({
    envVar: 'GRIST_AUDIT_HTTP_PAYLOAD_FORMAT',
  });
  if (payloadFormat !== 'hec') { return undefined; }

  const authorizationHeader = settings.flag('authorizationHeader').readString({
    envVar: 'GRIST_AUDIT_HTTP_AUTHORIZATION_HEADER',
    censor: true,
  });

  return {endpoint, authorizationHeader};
}
