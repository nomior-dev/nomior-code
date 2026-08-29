/**
 * Normalized record shapes every connector driver emits.
 *
 * The context engine ingests exactly two things: a `ConnectorSource` (one
 * logical document — a meeting, a note, a calendar event, a mail message)
 * and its ordered `ConnectorChunk`s (retrieval units preserving speaker and
 * timestamps). Drivers translate their native stores into these shapes;
 * nothing downstream knows driver-specific formats.
 *
 * @module nomior/connectors/Records
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Open branded slug naming a connector driver implementation (`anarlog`,
 * `googleCalendar`, `gmail`). Same slug discipline as
 * `ProviderDriverKind` — validated shape, not membership; the registry
 * downgrades unknown kinds gracefully.
 */
const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);

export const ConnectorDriverKind = slugSchema.pipe(Schema.brand("ConnectorDriverKind"));
export type ConnectorDriverKind = typeof ConnectorDriverKind.Type;

/**
 * One connected account of a driver. Multiple accounts per driver are first
 * class (two Google accounts, two Anarlog store paths); branded separately
 * from `ConnectorDriverKind` so the two can never be confused.
 */
export const ConnectorAccountId = slugSchema.pipe(Schema.brand("ConnectorAccountId"));
export type ConnectorAccountId = typeof ConnectorAccountId.Type;

export const ConnectorSourceKind = Schema.Literals([
  "meeting_transcript",
  "meeting_notes",
  "calendar_event",
  "mail_message",
]);
export type ConnectorSourceKind = typeof ConnectorSourceKind.Type;

export const ConnectorParticipant = Schema.Struct({
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
export type ConnectorParticipant = typeof ConnectorParticipant.Type;

/**
 * Cross-source link keys. Populated from the driver's own store so the
 * meeting-assembly layer can join records without driver-specific lookups:
 * a note links to its meeting via `meetingSessionId`; a recurring calendar
 * instance carries `recurringSeriesId` (Google `recurringEventId`); a mail
 * message carries `mailThreadId`.
 */
export const ConnectorSourceLinks = Schema.Struct({
  meetingSessionId: Schema.optional(Schema.String),
  calendarEventId: Schema.optional(Schema.String),
  recurringSeriesId: Schema.optional(Schema.String),
  mailThreadId: Schema.optional(Schema.String),
});
export type ConnectorSourceLinks = typeof ConnectorSourceLinks.Type;

/**
 * Where a record came from, precisely enough to re-fetch or audit it:
 * driver + account + the id the record has in the external store.
 */
export const ConnectorProvenance = Schema.Struct({
  driverKind: ConnectorDriverKind,
  accountId: ConnectorAccountId,
  externalId: Schema.String,
  externalUpdatedAt: Schema.optional(IsoDateTime),
});
export type ConnectorProvenance = typeof ConnectorProvenance.Type;

export const ConnectorSource = Schema.Struct({
  /** Stable id, unique within (driverKind, accountId). */
  sourceId: Schema.String,
  kind: ConnectorSourceKind,
  title: Schema.String,
  startedAt: Schema.optional(IsoDateTime),
  endedAt: Schema.optional(IsoDateTime),
  participants: Schema.Array(ConnectorParticipant),
  links: ConnectorSourceLinks,
  provenance: ConnectorProvenance,
});
export type ConnectorSource = typeof ConnectorSource.Type;

/**
 * One retrieval unit of a source. Transcript segments preserve the speaker
 * label and millisecond offsets relative to the source's `startedAt`.
 */
export const ConnectorChunk = Schema.Struct({
  chunkId: Schema.String,
  sourceId: Schema.String,
  index: Schema.Int,
  text: Schema.String,
  speaker: Schema.optional(Schema.String),
  startMs: Schema.optional(Schema.Int),
  endMs: Schema.optional(Schema.Int),
});
export type ConnectorChunk = typeof ConnectorChunk.Type;

export const ConnectorRecord = Schema.Struct({
  source: ConnectorSource,
  chunks: Schema.Array(ConnectorChunk),
});
export type ConnectorRecord = typeof ConnectorRecord.Type;

/**
 * Result of one incremental `sync(cursor)` call.
 *
 * `nextCursor` is the driver-opaque continuation token to persist; `null`
 * means the stream has no incremental handle (caller keeps the old cursor).
 * `cursorInvalidated` is true when the driver had to discard the supplied
 * cursor and perform a full resync (Calendar 410 GONE, Gmail expired
 * historyId) — callers should treat the batch as a fresh baseline, not a
 * delta.
 *
 * `hasMore` is true when the driver stopped at an internal batch cap
 * before draining the source: the caller must call `sync` again with
 * `nextCursor` (immediately, not on the next schedule) until it comes back
 * absent/false, or the tail past the cap is silently lost. Absent means
 * drained.
 */
export const ConnectorSyncResult = Schema.Struct({
  records: Schema.Array(ConnectorRecord),
  nextCursor: Schema.NullOr(Schema.String),
  cursorInvalidated: Schema.Boolean,
  hasMore: Schema.optional(Schema.Boolean),
});
export type ConnectorSyncResult = typeof ConnectorSyncResult.Type;
