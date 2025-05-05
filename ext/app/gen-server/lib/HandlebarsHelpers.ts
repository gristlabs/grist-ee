/** A few extra helpers needed for our templates, to keep parity with
 *  the Handlebars helpers available in Sendgrid.
 *
 * Sendgrid implements many helpers, but we only need a couple:
 *
 *   https://www.twilio.com/docs/sendgrid/for-developers/sending-email/using-handlebars#handlebars-reference
 */

import Handlebars, { HelperOptions } from 'handlebars';

Handlebars.registerHelper('equals', function (
  this: unknown,
  a: unknown,
  b: unknown,
  options: HelperOptions
): string {
  return a === b ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('notEquals', function (
  this: unknown,
  a: unknown,
  b: unknown,
  options: HelperOptions
): string {
  return a !== b ? options.fn(this) : options.inverse(this);
});
