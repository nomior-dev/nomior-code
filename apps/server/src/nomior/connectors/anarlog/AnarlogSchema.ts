/**
 * Anarlog local-store schema contract.
 *
 * Anarlog (fastrepl/anarlog, ex-Hyprnote) keeps its data in a sqlx-managed
 * SQLite file (`app.db`). Its schema is NOT a public contract, so this
 * module pins exactly what we read and which schema versions we have
 * contract-tested against. Sources (verified against the anarlog tree,
 * 2026-08-29): `crates/db-app/migrations/20260710223922_canonical_data_model.sql`
 * for the tables, `crates/owhisper-interface/src/lib.rs` for the
 * `words_json` element shape (`Word2` / `SpeakerIdentity`).
 *
 * @module nomior/connectors/anarlog/AnarlogSchema
 */
import * as Schema from "effect/Schema";

/**
 * sqlx migration versions (their `_sqlx_migrations.version`, a
 * `YYYYMMDDHHMMSS` integer) this connector is contract-tested against.
 *
 * The canonical data model we read landed in 20260710223922; the newest
 * migration verified not to reshape the tables we read is
 * 20260826120000. A store whose max applied version is below the floor or
 * above the ceiling is treated as UNKNOWN: the driver degrades to the
 * markdown-export fallback and reports "awaiting-update" — it never
 * guesses at an untested schema.
 */
export const ANARLOG_SCHEMA_VERSION_FLOOR = 20260710223922n;
export const ANARLOG_SCHEMA_VERSION_CEILING = 20260826120000n;

export const isKnownAnarlogSchemaVersion = (maxAppliedVersion: bigint): boolean =>
  maxAppliedVersion >= ANARLOG_SCHEMA_VERSION_FLOOR &&
  maxAppliedVersion <= ANARLOG_SCHEMA_VERSION_CEILING;

export const anarlogSupportedRangeLabel = `${ANARLOG_SCHEMA_VERSION_FLOOR}..${ANARLOG_SCHEMA_VERSION_CEILING}`;

/** `SpeakerIdentity` — serde `tag = "type", content = "value"` encoding. */
export const AnarlogSpeakerIdentity = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("unassigned"),
    value: Schema.Struct({ index: Schema.Int }),
  }),
  Schema.Struct({
    type: Schema.Literal("assigned"),
    value: Schema.Struct({ id: Schema.String, label: Schema.String }),
  }),
]);
export type AnarlogSpeakerIdentity = typeof AnarlogSpeakerIdentity.Type;

/** One element of `transcripts.words_json` (their legacy-but-stable `Word2`). */
export const AnarlogWord = Schema.Struct({
  text: Schema.String,
  speaker: Schema.optional(Schema.NullOr(AnarlogSpeakerIdentity)),
  confidence: Schema.optional(Schema.NullOr(Schema.Number)),
  start_ms: Schema.optional(Schema.NullOr(Schema.Int)),
  end_ms: Schema.optional(Schema.NullOr(Schema.Int)),
});
export type AnarlogWord = typeof AnarlogWord.Type;

export const AnarlogWords = Schema.fromJsonString(Schema.Array(AnarlogWord));

/** Subset of `sessions` columns we read. */
export const AnarlogSessionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.String,
  eventId: Schema.String,
  externalEventId: Schema.String,
  seriesId: Schema.String,
  updatedAt: Schema.String,
  effectiveUpdatedAt: Schema.String,
});
export type AnarlogSessionRow = typeof AnarlogSessionRow.Type;

/** Subset of `transcripts` columns we read. */
export const AnarlogTranscriptRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  startedAtMs: Schema.Int,
  words: AnarlogWords,
  updatedAt: Schema.String,
});
export type AnarlogTranscriptRow = typeof AnarlogTranscriptRow.Type;

/** Subset of `session_documents` columns we read (notes). */
export const AnarlogDocumentRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  bodyFormat: Schema.String,
  body: Schema.String,
  updatedAt: Schema.String,
});
export type AnarlogDocumentRow = typeof AnarlogDocumentRow.Type;

/** Subset of `session_participants` columns we read. */
export const AnarlogParticipantRow = Schema.Struct({
  sessionId: Schema.String,
  displayName: Schema.String,
  email: Schema.String,
});
export type AnarlogParticipantRow = typeof AnarlogParticipantRow.Type;

export interface AnarlogSessionBundle {
  readonly session: AnarlogSessionRow;
  readonly transcripts: ReadonlyArray<AnarlogTranscriptRow>;
  readonly documents: ReadonlyArray<AnarlogDocumentRow>;
  readonly participants: ReadonlyArray<AnarlogParticipantRow>;
}
