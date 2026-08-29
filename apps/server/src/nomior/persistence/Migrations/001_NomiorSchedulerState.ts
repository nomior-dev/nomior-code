import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Normalized per-instance rate-limit headroom derived from provider runtime
  // events. Rebuildable from scratch: rows are overwritten by newer events and
  // an empty table simply means "no signal yet", so dropping it is always safe.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_instance_rate_limits (
      instance_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      used_percent REAL,
      resets_at TEXT,
      observed_at TEXT NOT NULL
    )
  `;

  // Sticky per-project instance assignments recorded by the scheduler for
  // NEW threads only. Advisory data: deleting a row never breaks a thread.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_scheduler_assignments (
      project_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
