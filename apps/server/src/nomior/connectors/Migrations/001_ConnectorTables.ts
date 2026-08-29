import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
});
