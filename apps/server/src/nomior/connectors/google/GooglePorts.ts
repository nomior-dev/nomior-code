/**
 * Injectable network ports for the Google connectors.
 *
 * The sync loops never talk to the network directly — they speak to these
 * Context services, so tests run against fakes and the live layer
 * (`googleapisRuntime.ts`) is the only place that touches the `googleapis`
 * SDK. Ports take an `accountId` and resolve that account's credentials
 * internally (via `GoogleTokenVault`), keeping multi-account isolation a
 * property of the port, not of every caller.
 *
 * @module nomior/connectors/google/GooglePorts
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ConnectorAccountId } from "../Records.ts";

/**
 * Google API failure with the HTTP status preserved — the sync loops
 * branch on it (Calendar 410 GONE and Gmail 404 both mean "your
 * incremental cursor is no longer valid, do a full resync").
 */
export class GoogleApiError extends Schema.TaggedErrorClass<GoogleApiError>()("GoogleApiError", {
  status: Schema.Int,
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `Google API ${this.operation} failed with status ${this.status}`
      : `Google API ${this.operation} failed with status ${this.status}: ${this.detail}`;
  }
}

export const isGoogleApiError = Schema.is(GoogleApiError);

export const isCursorInvalidationError = (error: GoogleApiError): boolean =>
  error.status === 410 || error.status === 404;

// --- Calendar ---------------------------------------------------------------

export interface GoogleCalendarEventTime {
  readonly dateTime?: string;
  readonly date?: string;
}

export interface GoogleCalendarAttendee {
  readonly email?: string;
  readonly displayName?: string;
}

export interface GoogleCalendarEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly start?: GoogleCalendarEventTime;
  readonly end?: GoogleCalendarEventTime;
  readonly attendees?: ReadonlyArray<GoogleCalendarAttendee>;
  /** Present on instances of a recurring series — the series grouping key. */
  readonly recurringEventId?: string;
  readonly updated?: string;
}

export interface GoogleCalendarListInput {
  readonly accountId: ConnectorAccountId;
  readonly calendarId: string;
  readonly syncToken?: string;
  readonly pageToken?: string;
  /**
   * Lower bound for token-less (initial/full) syncs so a decade-old
   * calendar doesn't force an unbounded walk. Must never be combined with
   * `syncToken` — Google rejects the pair; `timeMin` alone still yields a
   * `nextSyncToken`.
   */
  readonly timeMin?: string;
}

export interface GoogleCalendarListPage {
  readonly items: ReadonlyArray<GoogleCalendarEvent>;
  readonly nextPageToken?: string;
  /** Only present on the final page of a sync window. */
  readonly nextSyncToken?: string;
}

export class GoogleCalendarPort extends Context.Service<
  GoogleCalendarPort,
  {
    readonly listEvents: (
      input: GoogleCalendarListInput,
    ) => Effect.Effect<GoogleCalendarListPage, GoogleApiError>;
  }
>()("t3/nomior/connectors/google/GooglePorts/GoogleCalendarPort") {}

// --- Gmail ------------------------------------------------------------------

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
}

export interface GmailMessageRef {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: ReadonlyArray<string>;
  /** Epoch milliseconds as decimal string, per the Gmail API. */
  readonly internalDate?: string;
  readonly subject?: string;
  readonly from?: string;
  readonly to?: string;
  readonly snippet?: string;
}

export interface GmailHistoryInput {
  readonly accountId: ConnectorAccountId;
  readonly startHistoryId: string;
  readonly pageToken?: string;
}

export interface GmailHistoryPage {
  readonly messagesAdded: ReadonlyArray<GmailMessageRef>;
  /**
   * Refs from `labelsAdded` history entries: an existing message that just
   * gained a label. Without these, labeling an old message with a selected
   * label would never ingest it.
   */
  readonly labelsAdded?: ReadonlyArray<GmailMessageRef>;
  readonly nextPageToken?: string;
  readonly historyId?: string;
}

/** One Gmail label: `id` is what messages carry, `name` is what search takes. */
export interface GmailLabel {
  readonly id: string;
  readonly name: string;
}

export interface GmailListMessagesInput {
  readonly accountId: ConnectorAccountId;
  /** Gmail search query (`from:a@b.c`, `label:x`, …). */
  readonly query: string;
  readonly pageToken?: string;
}

export interface GmailListMessagesPage {
  readonly messages: ReadonlyArray<GmailMessageRef>;
  readonly nextPageToken?: string;
}

export class GmailPort extends Context.Service<
  GmailPort,
  {
    readonly getProfile: (input: {
      readonly accountId: ConnectorAccountId;
    }) => Effect.Effect<GmailProfile, GoogleApiError>;
    readonly listHistory: (
      input: GmailHistoryInput,
    ) => Effect.Effect<GmailHistoryPage, GoogleApiError>;
    readonly listMessages: (
      input: GmailListMessagesInput,
    ) => Effect.Effect<GmailListMessagesPage, GoogleApiError>;
    readonly getMessage: (input: {
      readonly accountId: ConnectorAccountId;
      readonly id: string;
    }) => Effect.Effect<GmailMessage, GoogleApiError>;
    readonly listLabels: (input: {
      readonly accountId: ConnectorAccountId;
    }) => Effect.Effect<ReadonlyArray<GmailLabel>, GoogleApiError>;
  }
>()("t3/nomior/connectors/google/GooglePorts/GmailPort") {}

// --- OAuth token endpoint ---------------------------------------------------

export const GoogleTokenSet = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  /** Epoch milliseconds when the access token expires. */
  expiryMs: Schema.optionalKey(Schema.Int),
  scopes: Schema.Array(Schema.String),
});
export type GoogleTokenSet = typeof GoogleTokenSet.Type;

export class GoogleTokenPort extends Context.Service<
  GoogleTokenPort,
  {
    /** PKCE exchange — desktop clients send no client secret. */
    readonly exchangeAuthorizationCode: (input: {
      readonly clientId: string;
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    }) => Effect.Effect<GoogleTokenSet, GoogleApiError>;
    readonly refreshAccessToken: (input: {
      readonly clientId: string;
      readonly refreshToken: string;
    }) => Effect.Effect<GoogleTokenSet, GoogleApiError>;
    readonly revokeToken: (input: {
      readonly token: string;
    }) => Effect.Effect<void, GoogleApiError>;
  }
>()("t3/nomior/connectors/google/GooglePorts/GoogleTokenPort") {}
