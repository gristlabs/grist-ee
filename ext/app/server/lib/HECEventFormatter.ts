import { AuditLogStreamingDestinationName } from "app/common/Config";
import { AuditEvent } from "app/server/lib/AuditEvent";
import { AuditEventFormatter } from "app/server/lib/AuditEventFormatter";
import moment from "moment-timezone";

export class HECEventFormatter implements AuditEventFormatter {
  public streamingDestinations: AuditLogStreamingDestinationName[] = ["splunk"];

  public formatEvent(event: AuditEvent) {
    // The expected format of the `time` metadata is `[seconds].[milliseconds]`,
    // as documented [here](https://docs.splunk.com/Documentation/SplunkCloud/latest/Data/FormateventsforHTTPEventCollector#Event_metadata).
    const timestampMs = moment(event.timestamp).format("x");
    const time = `${timestampMs.slice(0, -3)}.${timestampMs.slice(-3)}`;

    return {
      time,
      event,
    };
  }
}
