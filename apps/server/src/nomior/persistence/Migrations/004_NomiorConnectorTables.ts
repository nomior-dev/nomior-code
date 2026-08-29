import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Connector accounts and per-stream sync cursors.
 *
 * The DDL is unchanged from the connectors track's own migrator, which tracked
 * itself in a separate `nomior_connector_migrations` ledger. Databases created
 * by that build already hold these tables (the DDL is `IF NOT EXISTS`), so this
 * entry is a no-op there and only the stale ledger needs removing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_connector_accounts (
      account_id TEXT PRIMARY KEY NOT NULL,
      driver_kind TEXT NOT NULL,
      display_name TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'connected',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_connector_accounts_driver_kind
    ON nomior_connector_accounts (driver_kind)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_connector_cursors (
      account_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, stream_id)
    )
  `;

  yield* sql`DROP TABLE IF EXISTS nomior_connector_migrations`;
});
