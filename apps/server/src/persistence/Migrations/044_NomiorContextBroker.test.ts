import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_NomiorContextBroker", (it) => {
  it.effect("creates the nomior context tables and keeps FTS in sync via triggers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

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

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 44 });
      const sql = yield* SqlClient.SqlClient;
      // The DDL is IF NOT EXISTS throughout; re-executing the migration body
      // against an already-migrated database must not fail.
      const migration = yield* Effect.promise(() => import("./044_NomiorContextBroker.ts"));
      yield* migration.default;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nomior_sources'
      `;
      assert.strictEqual(tables.length, 1);
    }),
  );
});
