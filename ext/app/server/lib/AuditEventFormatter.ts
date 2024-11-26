import { AuditLogStreamingDestinationName } from "app/common/Config";
import { AuditEvent } from "app/server/lib/AuditEvent";
import moment from "moment-timezone";

export interface AuditEventFormatter {
  streamingDestinations: AuditLogStreamingDestinationName[];
  formatEvent(event: AuditEvent): any;
}

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

export class GenericEventFormatter implements AuditEventFormatter {
  public streamingDestinations: AuditLogStreamingDestinationName[] = ["other"];

  public formatEvent(event: AuditEvent) {
    return event;
  }
}
