/**
 * Read-only access to an Anarlog `app.db`.
 *
 * The store belongs to another running app, so the contract is strict:
 * open with `readOnly: true` (never write, never take a write lock; WAL
 * reads are safe against a live writer), read the applied sqlx migration
 * version first, refuse to interpret tables outside the tested version
 * range (see `AnarlogSchema.ts`), and never surface a row the owning app
 * hides from its own user — soft-deleted (`deleted_at`) or held behind
 * device authentication (`sessions.locked`).
 *
 * @module nomior/connectors/anarlog/AnarlogStore
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AnarlogDocumentRow,
  AnarlogParticipantRow,
  type AnarlogSessionBundle,
  AnarlogSessionRow,
  AnarlogTranscriptRow,
} from "./AnarlogSchema.ts";

export class AnarlogStoreError extends Schema.TaggedErrorClass<AnarlogStoreError>()(
  "AnarlogStoreError",
  {
    operation: Schema.String,
    storePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Anarlog store ${this.operation} failed for ${this.storePath}`;
  }
}

export interface AnarlogSyncPosition {
  readonly updatedAt: string;
  readonly sessionId: string;
}

export interface AnarlogStoreReader {
  readonly storePath: string;
  /** Max applied `_sqlx_migrations.version`; none when the table is absent. */
  readonly schemaVersion: Effect.Effect<Option.Option<bigint>, AnarlogStoreError>;
  /**
   * Session bundles whose effective update position is strictly after
   * `since`, ordered by (effectiveUpdatedAt, id) so a cursor can resume
   * without skipping timestamp ties. Effective update time is the max of
   * the session row and its transcripts/documents, so transcript-only
   * edits still surface.
   */
  readonly listSessionBundlesSince: (
    since: AnarlogSyncPosition | null,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<AnarlogSessionBundle>, AnarlogStoreError>;
}

const decodeSessionRows = Schema.decodeUnknownEffect(Schema.Array(AnarlogSessionRow));
const decodeTranscriptRows = Schema.decodeUnknownEffect(Schema.Array(AnarlogTranscriptRow));
const decodeDocumentRows = Schema.decodeUnknownEffect(Schema.Array(AnarlogDocumentRow));
const decodeParticipantRows = Schema.decodeUnknownEffect(Schema.Array(AnarlogParticipantRow));

/**
 * `sessions.locked` is anarlog's per-note privacy lock, added in
 * `crates/db-app/migrations/20260820120000_session_locked.sql` (verified
 * 2026-08-29): "the desktop UI requires device authentication before
 * revealing a locked note". Ingesting one would strip that gate — retrieval
 * has no device auth to re-impose — so a locked session and all of its
 * children stay out.
 *
 * The column is newer than `ANARLOG_SCHEMA_VERSION_FLOOR` (20260710223922),
 * so a store in the lower half of the supported range does not have it and
 * an unconditional predicate would fail every sync with "no such column".
 * The predicate is therefore chosen from the store's actual columns, not
 * from its migration version: absent column ⇒ a build with no lock feature
 * ⇒ nothing to hide. `= 0` rather than `!= 1` so any future non-boolean
 * value reads as locked.
 */
const sessionsSinceSql = (lockedColumnPresent: boolean) => `
  SELECT * FROM (
    SELECT
      s.id AS id,
      s.title AS title,
      s.started_at AS startedAt,
      s.ended_at AS endedAt,
      s.event_id AS eventId,
      s.external_event_id AS externalEventId,
      s.series_id AS seriesId,
      s.updated_at AS updatedAt,
      MAX(
        s.updated_at,
        IFNULL((SELECT MAX(t.updated_at) FROM transcripts t
                WHERE t.session_id = s.id AND t.deleted_at IS NULL), ''),
        IFNULL((SELECT MAX(d.updated_at) FROM session_documents d
                WHERE d.session_id = s.id AND d.deleted_at IS NULL), '')
      ) AS effectiveUpdatedAt
    FROM sessions s
    WHERE s.deleted_at IS NULL${lockedColumnPresent ? "\n      AND s.locked = 0" : ""}
  )
  WHERE effectiveUpdatedAt > ? OR (effectiveUpdatedAt = ? AND id > ?)
  ORDER BY effectiveUpdatedAt ASC, id ASC
  LIMIT ?
`;

const transcriptsSql = `
  SELECT
    id,
    session_id AS sessionId,
    started_at_ms AS startedAtMs,
    words_json AS words,
    updated_at AS updatedAt
  FROM transcripts
  WHERE session_id = ? AND deleted_at IS NULL
  ORDER BY started_at_ms ASC, id ASC
`;

const documentsSql = `
  SELECT
    id,
    session_id AS sessionId,
    kind,
    title,
    body_format AS bodyFormat,
    body,
    updated_at AS updatedAt
  FROM session_documents
  WHERE session_id = ? AND deleted_at IS NULL
  ORDER BY sort_order ASC, id ASC
`;

const participantsSql = `
  SELECT
    session_id AS sessionId,
    display_name AS displayName,
    email
  FROM session_participants
  WHERE session_id = ? AND deleted_at IS NULL
  ORDER BY id ASC
`;

/**
 * Open the store read-only for the lifetime of the surrounding scope.
 */
export const openAnarlogStore = Effect.fnUntraced(function* (storePath: string) {
  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(storePath, { readOnly: true });
        // `readOnly` already opens with SQLITE_OPEN_READONLY; `query_only` is
        // the second, connection-level guard, and it also covers statements
        // that would reach an attached database. Two independent refusals mean
        // a future option change here cannot silently make us a writer to
        // another app's live store.
        database.exec("PRAGMA query_only = ON");
        return database;
      },
      catch: (cause) => new AnarlogStoreError({ operation: "open", storePath, cause }),
    }),
    (database) => Effect.sync(() => database.close()).pipe(Effect.ignore),
  );

  const query = (operation: string, sqlText: string, params: ReadonlyArray<string | number>) =>
    Effect.try({
      try: () => db.prepare(sqlText).all(...params) as ReadonlyArray<unknown>,
      catch: (cause) => new AnarlogStoreError({ operation, storePath, cause }),
    });

  /**
   * Probed once per open. `pragma_table_info` returns no rows (not an error)
   * for a table that does not exist, so this is also safe on a store that is
   * not an anarlog database at all. A probe that throws fails the open rather
   * than picking a predicate on a guess.
   */
  const lockedColumnPresent = yield* Effect.try({
    try: () =>
      db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = ?").all("locked")
        .length > 0,
    catch: (cause) => new AnarlogStoreError({ operation: "probeSessionColumns", storePath, cause }),
  });

  const toDecodeError = (operation: string) => (cause: Schema.SchemaError) =>
    new AnarlogStoreError({ operation, storePath, cause });

  const schemaVersion = Effect.try({
    try: () => {
      const tablePresent = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
        .all();
      if (tablePresent.length === 0) {
        return Option.none<bigint>();
      }
      const statement = db.prepare(
        "SELECT MAX(version) AS version FROM _sqlx_migrations WHERE success = 1",
      );
      statement.setReadBigInts(true);
      const rows = statement.all() as unknown as ReadonlyArray<{
        readonly version: bigint | null;
      }>;
      const version = rows[0]?.version;
      return version === null || version === undefined
        ? Option.none<bigint>()
        : Option.some(BigInt(version));
    },
    catch: (cause) => new AnarlogStoreError({ operation: "schemaVersion", storePath, cause }),
  });

  const listSessionBundlesSince: AnarlogStoreReader["listSessionBundlesSince"] = (since, limit) =>
    Effect.gen(function* () {
      const sinceUpdatedAt = since?.updatedAt ?? "";
      const sinceSessionId = since?.sessionId ?? "";
      const sessionRows = yield* query("listSessions", sessionsSinceSql(lockedColumnPresent), [
        sinceUpdatedAt,
        sinceUpdatedAt,
        sinceSessionId,
        limit,
      ]);
      const sessions = yield* decodeSessionRows(sessionRows).pipe(
        Effect.mapError(toDecodeError("decodeSessions")),
      );

      const bundles: Array<AnarlogSessionBundle> = [];
      for (const session of sessions) {
        const [transcriptRows, documentRows, participantRows] = yield* Effect.all([
          query("listTranscripts", transcriptsSql, [session.id]),
          query("listDocuments", documentsSql, [session.id]),
          query("listParticipants", participantsSql, [session.id]),
        ]);
        const transcripts = yield* decodeTranscriptRows(transcriptRows).pipe(
          Effect.mapError(toDecodeError("decodeTranscripts")),
        );
        const documents = yield* decodeDocumentRows(documentRows).pipe(
          Effect.mapError(toDecodeError("decodeDocuments")),
        );
        const participants = yield* decodeParticipantRows(participantRows).pipe(
          Effect.mapError(toDecodeError("decodeParticipants")),
        );
        bundles.push({ session, transcripts, documents, participants });
      }
      return bundles;
    });

  return {
    storePath,
    schemaVersion,
    listSessionBundlesSince,
  } satisfies AnarlogStoreReader;
});
