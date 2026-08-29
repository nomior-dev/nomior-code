import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Advisory mode and the scheduler's last decision.
 *
 * Both are single-valued settings rather than per-entity rows, and neither fits
 * the tables migration 006 added: `nomior_scheduler_assignments` is keyed by
 * project and means something else, and upstream's `ServerSettings` is a
 * JSON-file service over a frozen schema with no extension slot.
 *
 * Nullable columns, so writing advisory mode never disturbs the recorded
 * decision and vice versa.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_scheduler_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      advisory_mode INTEGER,
      last_decision_instance_id TEXT,
      last_decision_reason TEXT,
      last_decision_decided_at TEXT
    )
  `;
});
