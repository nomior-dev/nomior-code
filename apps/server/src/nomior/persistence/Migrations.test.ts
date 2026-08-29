import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runNomiorMigrations } from "./Migrations.ts";
import { NomiorSqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = NomiorSqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));

describe("Nomior migrations", () => {
  it.effect("creates the Nomior tables alongside the upstream schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const names = tables.map((row) => row.name);

      assert.include(names, "nomior_instance_rate_limits");
      assert.include(names, "nomior_scheduler_assignments");
      assert.include(names, "nomior_review_jobs");
      assert.include(names, "nomior_review_job_starts");
      // Nomior tracks its migrations separately from upstream's.
      assert.include(names, "nomior_sql_migrations");
      assert.include(names, "effect_sql_migrations");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("is idempotent across repeated runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rerun = yield* runNomiorMigrations();
      assert.deepStrictEqual(rerun, []);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM nomior_sql_migrations
      `;
      assert.strictEqual(rows[0]?.count, 2);
    }).pipe(Effect.provide(TestLayer)),
  );
});
