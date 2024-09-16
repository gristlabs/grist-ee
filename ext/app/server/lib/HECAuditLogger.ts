import {AuditEvent, AuditEventName} from 'app/common/AuditEvent';
import {IAuditLogger} from 'app/server/lib/AuditLogger';
import {HTTPAuditLogger} from 'app/server/lib/HTTPAuditLogger';
import moment from 'moment-timezone';

export class HECAuditLogger extends HTTPAuditLogger implements IAuditLogger {
  protected toJSON<Name extends AuditEventName>({event, timestamp}: AuditEvent<Name>): string {
    return JSON.stringify({
      event,
      time: toUnixTimestamp(timestamp),
    });
  }
}

/**
 * Converts an ISO 8601 timestamp to a Unix timestamp.
 *
 * The format of the timestamp is `[seconds].[milliseconds]` (e.g. `"1725459194.123"`), as
 * documented [here](https://docs.splunk.com/Documentation/SplunkCloud/latest/Data/FormateventsforHTTPEventCollector#Event_metadata).
 */
function toUnixTimestamp(timestamp: string): string {
  const unixMs = moment(timestamp).format('x');
  return `${unixMs.slice(0, -3)}.${unixMs.slice(-3)}`;
}
