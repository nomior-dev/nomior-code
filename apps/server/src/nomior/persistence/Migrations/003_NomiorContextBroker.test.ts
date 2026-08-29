import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { runNomiorMigrations } from "../Migrations.ts";

// The shared setup layer turns foreign keys on before migrating, so the
// cascade path below is the one the real server takes.
const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

layer("003_NomiorContextBroker", (it) => {
  it.effect("creates the nomior context tables and keeps FTS in sync via triggers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')
      `;
      const names = new Set(tables.map((table) => table.name));
      for (const expected of [
        "nomior_sources",
        "nomior_source_scopes",
        "nomior_chunks",
        "nomior_chunks_fts",
        "nomior_embeddings",
        "nomior_decisions",
        "nomior_tasks",
        "nomior_chunks_fts_ai",
        "nomior_chunks_fts_ad",
        "nomior_chunks_fts_au",
      ]) {
        assert.ok(names.has(expected), `expected ${expected} to exist`);
      }

      yield* sql`
        INSERT INTO nomior_sources (id, kind, title, ingested_at)
        VALUES ('src-1', 'meeting', 'Kickoff', '2026-08-29T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO nomior_chunks (id, source_id, ordinal, text, contextual_prefix, char_start, char_end)
        VALUES ('src-1/0', 'src-1', 0, 'we ship the broker in september', 'Kickoff', 0, 31)
      `;

      const inserted = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks_fts WHERE nomior_chunks_fts MATCH 'broker'
      `;
      assert.strictEqual(inserted[0]?.n, 1);

      yield* sql`
        UPDATE nomior_chunks SET text = 'entirely different words' WHERE id = 'src-1/0'
      `;
      const afterUpdate = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks_fts WHERE nomior_chunks_fts MATCH 'broker'
      `;
      assert.strictEqual(afterUpdate[0]?.n, 0);
      const afterUpdateNew = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks_fts WHERE nomior_chunks_fts MATCH 'different'
      `;
      assert.strictEqual(afterUpdateNew[0]?.n, 1);

      // Deleting the source cascades to chunks and the cascade fires the FTS
      // delete trigger — the index must not retain ghost rows.
      yield* sql`DELETE FROM nomior_sources WHERE id = 'src-1'`;
      const chunkCount = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks
      `;
      assert.strictEqual(chunkCount[0]?.n, 0);
      const afterDelete = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks_fts WHERE nomior_chunks_fts MATCH 'different'
      `;
      assert.strictEqual(afterDelete[0]?.n, 0);

      yield* sql`INSERT INTO nomior_chunks_fts(nomior_chunks_fts) VALUES ('integrity-check')`;
    }),
  );
});

// A pre-consolidation build wrote this schema into upstream slot 44. That row
// makes the upstream Migrator skip the real 044 upstream will eventually ship,
// so the migration has to release the slot on databases that already have it.
it.effect("releases the upstream slot a pre-consolidation build squatted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (44, 'NomiorContextBroker'), (45, 'SomeUpstreamMigration')
    `;

    yield* runNomiorMigrations();

    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 44
    `;
    assert.deepStrictEqual(
      rows.map((row) => [Number(row.migration_id), row.name]),
      // Only our squatted row goes; an upstream-owned row is left alone.
      [[45, "SomeUpstreamMigration"]],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
