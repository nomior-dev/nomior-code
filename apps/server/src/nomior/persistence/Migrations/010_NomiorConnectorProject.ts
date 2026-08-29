import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Which project a connected account's material belongs to.
 *
 * Connector sources were scoped `capsule:<accountId>` and nothing else, which
 * made them unreachable from a project-scoped search — the only search the
 * context page and the MCP toolkit perform. An account that names a project
 * now also scopes its sources into it. Null means the account is not tied to
 * a project, which is the honest default for one nobody has assigned yet.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite has no `ADD COLUMN IF NOT EXISTS`, and every migration body must
  // survive a bare replay — see the note in 006.
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('nomior_connector_accounts') WHERE name = 'project_id'
  `;
  if (existing.length === 0) {
    yield* sql.unsafe(`ALTER TABLE nomior_connector_accounts ADD COLUMN project_id TEXT`);
  }
});
