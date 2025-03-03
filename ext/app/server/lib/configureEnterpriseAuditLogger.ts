import { HomeDBManager } from "app/gen-server/lib/homedb/HomeDBManager";
import {
  GenericEventFormatter,
  HECEventFormatter,
} from "app/server/lib/AuditEventFormatter";
import { AuditLogger } from "app/server/lib/AuditLogger";
import { GristServer } from "app/server/lib/GristServer";

export function configureEnterpriseAuditLogger(
  dbManager: HomeDBManager,
  gristServer: GristServer
) {
  return new AuditLogger(dbManager, {
    formatters: [new HECEventFormatter(), new GenericEventFormatter()],
    allowDestination() {
      return !gristServer.isRestrictedMode();
    },
    subscribe(callback) {
      gristServer.onStreamingDestinationsChange(callback);
    }
  });
}
