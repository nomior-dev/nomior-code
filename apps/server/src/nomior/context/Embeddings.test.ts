import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  cosineSimilarity,
  decodeVector,
  EmbeddingModelRegistry,
  EmbeddingModelRegistryDefault,
  EmbeddingWorker,
  EmbeddingWorkerLive,
  encodeVector,
  HASH_EMBEDDING_MODEL_ID,
  hashEmbed,
  hashEmbeddingModel,
  layerRegistry,
  makeEmbeddingWorker,
  type EmbeddingModel,
} from "./Embeddings.ts";
import { NomiorEmbeddingError, NomiorSourceId } from "./Model.ts";

describe("hashEmbed", () => {
  it("is deterministic and L2-normalized", () => {
    const a = hashEmbed("the deploy pipeline is broken");
    const b = hashEmbed("the deploy pipeline is broken");
    assert.deepStrictEqual([...a], [...b]);
    let norm = 0;
    for (const value of a) {
      norm += value * value;
    }
    assert.approximately(norm, 1, 1e-6);
  });

  it("captures lexical overlap across inflected forms (RU)", () => {
    const base = hashEmbed("запуск проекта");
    const inflected = hashEmbed("запуска проекта");
    const unrelated = hashEmbed("совершенно другое содержание");
    assert.isAbove(cosineSimilarity(base, inflected), cosineSimilarity(base, unrelated));
  });

  it("returns a zero vector for empty text", () => {
    const vector = hashEmbed("   ");
    assert.strictEqual(vector.length, 256);
    assert.ok([...vector].every((value) => value === 0));
  });
});

describe("vector codec", () => {
  it("round-trips through BLOB encoding", () => {
    const vector = hashEmbed("round trip");
    const decoded = decodeVector(encodeVector(vector));
    assert.deepStrictEqual([...decoded], [...vector]);
  });
});

const seedSource = (sql: SqlClient.SqlClient, sourceId: string, text: string) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO nomior_sources (id, kind, title, ingested_at)
      VALUES (${sourceId}, 'meeting', 'Seed', '2026-08-29T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO nomior_chunks (id, source_id, ordinal, text, contextual_prefix, char_start, char_end)
      VALUES (${`${sourceId}/0`}, ${sourceId}, 0, ${text}, 'Seed', 0, ${text.length})
    `;
  });

const workerLayer = it.layer(
  EmbeddingWorkerLive.pipe(
    Layer.provideMerge(EmbeddingModelRegistryDefault),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

workerLayer("EmbeddingWorker", (it) => {
  it.effect("embeds enqueued sources in the background and stores the model id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* EmbeddingWorker;

      yield* seedSource(sql, "emb-src-1", "we ship the broker in september");
      yield* worker.enqueue(NomiorSourceId.make("emb-src-1"));
      yield* worker.awaitIdle;

      const rows = yield* sql<{
        readonly modelId: string;
        readonly dim: number;
        readonly vector: Uint8Array;
      }>`
        SELECT model_id AS "modelId", dim AS "dim", vector AS "vector"
        FROM nomior_embeddings
        WHERE chunk_id = 'emb-src-1/0'
      `;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.modelId, HASH_EMBEDDING_MODEL_ID);
      assert.strictEqual(rows[0]!.dim, 256);
      assert.strictEqual(decodeVector(rows[0]!.vector).length, 256);
    }),
  );

  it.effect("drainPending embeds every chunk missing a vector for the active model", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* EmbeddingWorker;

      yield* seedSource(sql, "emb-src-2", "pending chunk one");
      yield* seedSource(sql, "emb-src-3", "pending chunk two");

      const embedded = yield* worker.drainPending;
      assert.isAtLeast(embedded, 2);

      const missing = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks c
        WHERE NOT EXISTS (
          SELECT 1 FROM nomior_embeddings e
          WHERE e.chunk_id = c.id AND e.model_id = ${HASH_EMBEDDING_MODEL_ID}
        )
      `;
      assert.strictEqual(missing[0]?.n, 0);

      const again = yield* worker.drainPending;
      assert.strictEqual(again, 0);
    }),
  );
});

describe("EmbeddingWorker failure handling", () => {
  it.effect("logs a failing job and keeps processing the next one", () =>
    Effect.gen(function* () {
      const flakyModel: EmbeddingModel = {
        id: "flaky-test-model",
        dim: 4,
        embed: (texts) =>
          texts.some((text) => text.includes("poison"))
            ? Effect.fail(
                new NomiorEmbeddingError({ modelId: "flaky-test-model", detail: "poisoned" }),
              )
            : Effect.succeed(texts.map(() => new Float32Array([1, 0, 0, 0]))),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const worker = yield* makeEmbeddingWorker;
          yield* seedSource(sql, "emb-src-4", "poison text that fails");
          yield* seedSource(sql, "emb-src-6", "good text after failure");
          yield* worker.enqueue(NomiorSourceId.make("emb-src-4"));
          yield* worker.enqueue(NomiorSourceId.make("emb-src-6"));
          yield* worker.awaitIdle;

          const failed = yield* sql<{ readonly n: number }>`
            SELECT count(*) AS n FROM nomior_embeddings WHERE chunk_id = 'emb-src-4/0'
          `;
          assert.strictEqual(failed[0]?.n, 0);
          const succeeded = yield* sql<{ readonly n: number }>`
            SELECT count(*) AS n FROM nomior_embeddings WHERE chunk_id = 'emb-src-6/0'
          `;
          assert.strictEqual(succeeded[0]?.n, 1);
        }),
      ).pipe(
        Effect.provide(
          layerRegistry({ models: [flakyModel], activeModelId: "flaky-test-model" }).pipe(
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    }),
  );
});

describe("EmbeddingModelRegistry", () => {
  it.effect("resolves the active model and looks up by id", () =>
    Effect.gen(function* () {
      const registry = yield* EmbeddingModelRegistry;
      assert.strictEqual(registry.active.id, HASH_EMBEDDING_MODEL_ID);
      assert.ok(Option.isSome(registry.get(HASH_EMBEDDING_MODEL_ID)));
      assert.ok(Option.isNone(registry.get("embedding-gemma-300m")));
    }).pipe(Effect.provide(EmbeddingModelRegistryDefault)),
  );
});

describe("EmbeddingWorker cancellation", () => {
  it.effect("closing the scope interrupts in-flight embedding work", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const blockingModel: EmbeddingModel = {
        id: "blocking-test-model",
        dim: 4,
        embed: () => Deferred.succeed(started, undefined).pipe(Effect.flatMap(() => Effect.never)),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const worker = yield* makeEmbeddingWorker;
          yield* seedSource(sql, "emb-src-5", "never finishes embedding");
          yield* worker.enqueue(NomiorSourceId.make("emb-src-5"));
          // The model is now blocked inside embed(); closing the scope must
          // interrupt it — otherwise this test hangs and times out.
          yield* Deferred.await(started);
        }),
      ).pipe(
        Effect.provide(
          layerRegistry({ models: [blockingModel], activeModelId: "blocking-test-model" }).pipe(
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );

      assert.ok(true);
    }),
  );
});

describe("hashEmbeddingModel", () => {
  it.effect("returns one vector per input text", () =>
    Effect.gen(function* () {
      const vectors = yield* hashEmbeddingModel.embed(["one", "two", "three"]);
      assert.strictEqual(vectors.length, 3);
      assert.ok(vectors.every((vector) => vector.length === hashEmbeddingModel.dim));
    }),
  );
});
