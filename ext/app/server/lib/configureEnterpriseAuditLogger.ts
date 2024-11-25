import { AuditLogStreamingDestinationName } from "app/common/Config";
import { HomeDBManager } from "app/gen-server/lib/homedb/HomeDBManager";
import { GenericEventFormatter } from "app/server/lib/AuditEventFormatter";
import { AuditLogger } from "app/server/lib/AuditLogger";
import { GristServer } from "app/server/lib/GristServer";
import { HECEventFormatter } from "app/server/lib/HECEventFormatter";

export function configureEnterpriseAuditLogger(
  dbManager: HomeDBManager,
  gristServer: GristServer
) {
  const allowedEnterpriseDestinations = new Set<AuditLogStreamingDestinationName>([
    "splunk",
    "other",
  ]);
  const allowedCoreDestinations = new Set<AuditLogStreamingDestinationName>(["other"]);

  return new AuditLogger(dbManager, {
    formatters: [new HECEventFormatter(), new GenericEventFormatter()],
    allowDestination: ({ name }) => {
      if (!gristServer.getBilling().getActivationStatus().inGoodStanding) {
        // Revert to non-Enterprise feature set while not in good standing.
        return allowedCoreDestinations.has(name);
      } else {
        return allowedEnterpriseDestinations.has(name);
      }
    },
  });
}
