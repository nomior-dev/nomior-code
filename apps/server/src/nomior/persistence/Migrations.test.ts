import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { nomiorMigrationEntries, runNomiorMigrations } from "./Migrations.ts";

const TestLayer = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));

type SchemaRow = { readonly type: string; readonly name: string; readonly sql: string | null };

const schemaSnapshot = Effect.fn("schemaSnapshot")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<SchemaRow>`
    SELECT type, name, sql FROM sqlite_master ORDER BY type, name
  `;
});

describe("Nomior migrations", () => {
  it("numbers entries as a gapless ascending sequence with unique names", () => {
    assert.deepStrictEqual(
      nomiorMigrationEntries.map(([id]) => id),
      nomiorMigrationEntries.map((_, index) => index + 1),
    );
    const names = nomiorMigrationEntries.map(([, name]) => name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it.effect("creates every Nomior table alongside the upstream schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const names = tables.map((row) => row.name);

      for (const expected of [
        // 001_NomiorSchedulerState
        "nomior_instance_rate_limits",
        "nomior_scheduler_assignments",
        // 002_NomiorReviewJobs
        "nomior_review_jobs",
        "nomior_review_job_starts",
        // 003_NomiorContextBroker
        "nomior_sources",
        "nomior_source_scopes",
        "nomior_chunks",
        "nomior_chunks_fts",
        "nomior_embeddings",
        "nomior_decisions",
        "nomior_tasks",
        // 004_NomiorConnectorTables
        "nomior_connector_accounts",
        "nomior_connector_cursors",
      ]) {
        assert.include(names, expected);
      }

      // Nomior tracks its migrations separately from upstream's, and the
      // connectors track's third ledger is gone.
      assert.include(names, "nomior_sql_migrations");
      assert.include(names, "effect_sql_migrations");
      assert.notInclude(names, "nomior_connector_migrations");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records the entries in registry order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM nomior_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [Number(row.migration_id), row.name]),
        nomiorMigrationEntries.map(([id, name]) => [id, name]),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("running twice is a no-op", () =>
    Effect.gen(function* () {
      const before = yield* schemaSnapshot();

      const rerun = yield* runNomiorMigrations();
      assert.deepStrictEqual(rerun, []);

      // Stronger than the ledger check: replay every migration body against
      // the already-migrated database. All DDL is IF NOT EXISTS, so a replay
      // must neither fail nor change the schema.
      for (const [, , migration] of nomiorMigrationEntries) {
        yield* migration;
      }

      assert.deepStrictEqual(yield* schemaSnapshot(), before);
    }).pipe(Effect.provide(TestLayer)),
  );
});
