import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Nomior context broker storage: sources, chunks, an external-content FTS5
 * index kept in sync via triggers, embeddings keyed by model id, extracted
 * decisions/tasks with evidence spans, and a scope table binding sources to
 * project/customer/capsule.
 *
 * The FTS index and the embeddings table are derived state: both rebuild from
 * `nomior_chunks` (FTS via the 'rebuild' command, embeddings by re-running the
 * embedding worker), so no backfill is ever needed here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A pre-consolidation build registered this schema as upstream slot 44 in
  // `effect_sql_migrations`. Release the slot: while it is squatted the
  // Migrator skips upstream's real 044 (it only runs ids above the latest
  // recorded) and `migrate-dev-db`'s slot check hard-fails. Matched by name,
  // so a genuine upstream row in slot 44 is never touched. Guarded because the
  // upstream ledger only exists once upstream's migrator has run.
  const upstreamLedger = yield* sql<{ readonly n: number }>`
    SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (upstreamLedger[0]?.n === 1) {
    yield* sql`
      DELETE FROM effect_sql_migrations WHERE migration_id = 44 AND name = 'NomiorContextBroker'
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('meeting', 'document', 'email', 'memory', 'decision', 'session')),
      external_id TEXT,
      title TEXT NOT NULL,
      occurred_at TEXT,
      ingested_at TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}'
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nomior_sources_external
    ON nomior_sources(kind, external_id)
    WHERE external_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_source_scopes (
      source_id TEXT NOT NULL REFERENCES nomior_sources(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'customer', 'capsule')),
      scope_value TEXT NOT NULL,
      PRIMARY KEY (source_id, scope_kind, scope_value)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_source_scopes_lookup
    ON nomior_source_scopes(scope_kind, scope_value, source_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nomior_sources(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      contextual_prefix TEXT NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      speaker TEXT,
      ts_start REAL,
      ts_end REAL,
      UNIQUE (source_id, ordinal)
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS nomior_chunks_fts USING fts5(
      text,
      contextual_prefix,
      content='nomior_chunks',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `;

  // External-content FTS5 stays consistent only through these triggers; the
  // 'delete' command form is required because the index cannot look up the
  // old row itself. Cascaded deletes from nomior_sources fire the delete
  // trigger too (covered by this migration's test).
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS nomior_chunks_fts_ai AFTER INSERT ON nomior_chunks BEGIN
      INSERT INTO nomior_chunks_fts(rowid, text, contextual_prefix)
      VALUES (new.rowid, new.text, new.contextual_prefix);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS nomior_chunks_fts_ad AFTER DELETE ON nomior_chunks BEGIN
      INSERT INTO nomior_chunks_fts(nomior_chunks_fts, rowid, text, contextual_prefix)
      VALUES ('delete', old.rowid, old.text, old.contextual_prefix);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS nomior_chunks_fts_au AFTER UPDATE ON nomior_chunks BEGIN
      INSERT INTO nomior_chunks_fts(nomior_chunks_fts, rowid, text, contextual_prefix)
      VALUES ('delete', old.rowid, old.text, old.contextual_prefix);
      INSERT INTO nomior_chunks_fts(rowid, text, contextual_prefix)
      VALUES (new.rowid, new.text, new.contextual_prefix);
    END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_embeddings (
      chunk_id TEXT NOT NULL REFERENCES nomior_chunks(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (chunk_id, model_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_embeddings_model
    ON nomior_embeddings(model_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_decisions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nomior_sources(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES nomior_chunks(id) ON DELETE SET NULL,
      statement TEXT NOT NULL,
      decided_at TEXT,
      evidence_char_start INTEGER,
      evidence_char_end INTEGER,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_decisions_source
    ON nomior_decisions(source_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_tasks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nomior_sources(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES nomior_chunks(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      assignee TEXT,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
      evidence_char_start INTEGER,
      evidence_char_end INTEGER,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_tasks_source
    ON nomior_tasks(source_id)
  `;
});
