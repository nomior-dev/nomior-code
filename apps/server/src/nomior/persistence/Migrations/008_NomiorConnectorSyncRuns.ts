import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * When each connector account last completed a sync.
 *
 * Its own table rather than a column on `nomior_connector_accounts`: that
 * table's `updated_at` moves on every upsert (connect, status change), so
 * reusing it would report "synced" the moment an account is created. A
 * separate row is written only by a completed sync run, which is exactly what
 * the connectors panel's "last synced" reads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_connector_sync_runs (
      account_id TEXT PRIMARY KEY NOT NULL,
      last_synced_at TEXT NOT NULL
    )
  `;
});
