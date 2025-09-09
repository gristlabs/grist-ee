// This is the type of JSON object supported by GRIST_NODEMAILER_SENDER env var.
// It was originally documented as just an Address, and then got extended in a
// backwards-compatible way.
export interface Address {
  email: string;
  name: string;
}

export interface NodemailerSender extends Address {
  // Used for doc notifications. If omitted, defaults to the main sender email.
  docNotificationsFrom?: string;

  // Used for Reply-To in doc notifications. If omitted, defaults to docNotificationsFrom.
  docNotificationsReplyTo?: string;
}
