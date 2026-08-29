import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The ONE memory-candidate store. Both producers write here — the MCP
 * `context_remember` tool and the review engine's `MemoryCandidateSink` — and
 * the Nomior context panel reads the same rows.
 *
 * Approval is structural, not conventional: `status` starts at `pending` for
 * every insert and only an explicit resolve moves it. `promoted_source_id`
 * links an approved candidate to the `nomior_sources` row it became, so the
 * panel can show "this is memory now" and a re-approval is a no-op.
 *
 * `id` is a content hash of (source, scope, origin_ref, kind, text) computed by
 * the store, so re-offering the same candidate — the review engine re-running a
 * job, an agent repeating itself — is idempotent instead of duplicating rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_memory_candidates (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('review', 'context-tool')),
      scope_kind TEXT CHECK (scope_kind IN ('project', 'customer', 'capsule')),
      scope_value TEXT,
      origin_ref TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('finding', 'verdict', 'note')),
      severity TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      promoted_source_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_memory_candidates_status
    ON nomior_memory_candidates(status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_memory_candidates_scope
    ON nomior_memory_candidates(scope_kind, scope_value)
  `;
});
