/**
 * Format of sendgrid responses when looking up a user by email address using
 * SENDGRID.search
 */
export interface SendGridSearchResult {
  contact_count: number;
  result: SendGridSearchHit[];
}

export interface SendGridSearchHit {
  id: string;
  email: string;
  list_ids: string[];
}

/**
 * Alternative format of sendgrid responses when looking up a user by email
 * address using SENDGRID.searchByEmail
 *   https://docs.sendgrid.com/api-reference/contacts/get-contacts-by-emails
 */
export interface SendGridSearchResultVariant {
  result: Record<string, SendGridSearchPossibleHit>;
}

/**
 * Documentation is contradictory on format of results when contacts not found, but if
 * something is found there should be a contact field.
 */
export interface SendGridSearchPossibleHit {
  contact?: SendGridSearchHit;
}

export interface SendGridContact {
  contacts: [{
    email: string;
    first_name: string;
    last_name: string;
    custom_fields?: Record<string, any>;
  }],
  list_ids?: string[];
}
