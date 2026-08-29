/**
 * Embeddings - embedding models, their registry, and the background worker
 * that vectorizes chunks.
 *
 * Every stored vector carries its `model_id`, so switching the active model
 * never corrupts anything: old vectors are simply ignored by retrieval and the
 * worker regenerates the missing ones (`drainPending`) for the new model.
 *
 * Model seam: EmbeddingGemma-300M (the manifest default) plugs in as another
 * `EmbeddingModel` registered in `EmbeddingModelRegistry` with its own id —
 * no other module changes. The hash model below is the zero-download fallback
 * that keeps tests and first-run working offline.
 *
 * @module Embeddings
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type NomiorChunkId,
  NomiorEmbeddingError,
  type NomiorContextSqlError,
  type NomiorSourceId,
  toNomiorContextSqlError,
} from "./Model.ts";

export interface EmbeddingModel {
  readonly id: string;
  readonly dim: number;
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Float32Array>, NomiorEmbeddingError>;
}

// ===============================
// Vector codec + math
// ===============================

export const encodeVector = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

export const decodeVector = (bytes: Uint8Array): Float32Array => {
  // Copy into a fresh buffer: the source may be unaligned or shared.
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength >>> 2);
};

export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ===============================
// Hash embedding fallback
// ===============================

export const HASH_EMBEDDING_MODEL_ID = "nomior-hash-256-v1";
const HASH_EMBEDDING_DIM = 256;

const fnv1a = (text: string, seed: number): number => {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Feature-hashed character n-grams (3- and 4-grams within words, plus whole
 * words), signed hashing, L2-normalized. Deterministic, offline, and
 * script-agnostic (works equally on Latin and Cyrillic text). It captures
 * lexical overlap — including across inflected forms via shared n-grams — not
 * semantics; the dense leg upgrades to a real model via the registry seam.
 */
export const hashEmbed = (text: string, dim: number = HASH_EMBEDDING_DIM): Float32Array => {
  const vector = new Float32Array(dim);
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const addFeature = (feature: string) => {
    const hash = fnv1a(feature, 0);
    const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
    vector[hash % dim]! += sign;
  };
  for (const word of words) {
    addFeature(`w:${word}`);
    const padded = `^${word}$`;
    for (const n of [3, 4]) {
      for (let index = 0; index + n <= padded.length; index += 1) {
        addFeature(`g${n}:${padded.slice(index, index + n)}`);
      }
    }
  }
  let norm = 0;
  for (let index = 0; index < dim; index += 1) {
    norm += vector[index]! * vector[index]!;
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < dim; index += 1) {
      vector[index]! *= scale;
    }
  }
  return vector;
};

export const hashEmbeddingModel: EmbeddingModel = {
  id: HASH_EMBEDDING_MODEL_ID,
  dim: HASH_EMBEDDING_DIM,
  embed: (texts) => Effect.sync(() => texts.map((text) => hashEmbed(text))),
};

// ===============================
// Registry
// ===============================

export class EmbeddingModelRegistry extends Context.Service<
  EmbeddingModelRegistry,
  {
    readonly active: EmbeddingModel;
    readonly get: (id: string) => Option.Option<EmbeddingModel>;
    readonly list: ReadonlyArray<EmbeddingModel>;
  }
>()("t3/nomior/context/Embeddings/EmbeddingModelRegistry") {}

export interface EmbeddingModelRegistryOptions {
  readonly models: ReadonlyArray<EmbeddingModel>;
  readonly activeModelId: string;
}

export const layerRegistry = (options: EmbeddingModelRegistryOptions) =>
  Layer.effect(
    EmbeddingModelRegistry,
    Effect.gen(function* () {
      const byId = new Map(options.models.map((model) => [model.id, model]));
      const active = byId.get(options.activeModelId);
      if (active === undefined) {
        return yield* Effect.die(
          new Error(`Active embedding model ${options.activeModelId} is not registered.`),
        );
      }
      return {
        active,
        get: (id: string) => Option.fromNullishOr(byId.get(id)),
        list: options.models,
      };
    }),
  );

/** Offline default: the hash model only. Real models are added here. */
export const EmbeddingModelRegistryDefault = layerRegistry({
  models: [hashEmbeddingModel],
  activeModelId: HASH_EMBEDDING_MODEL_ID,
});

// ===============================
// Worker
// ===============================

const EMBED_BATCH_SIZE = 16;
const EMBED_CONCURRENCY = 2;

export class EmbeddingWorker extends Context.Service<
  EmbeddingWorker,
  {
    /** Queue a source's chunks for background embedding. Returns immediately. */
    readonly enqueue: (sourceId: NomiorSourceId) => Effect.Effect<void>;
    /**
     * Embed every chunk missing a vector for the active model, in the calling
     * fiber (interruptible). Rebuild path after a model change. Returns the
     * number of chunks embedded.
     */
    readonly drainPending: Effect.Effect<number, NomiorContextSqlError | NomiorEmbeddingError>;
    /** Wait until every enqueued job has been processed. */
    readonly awaitIdle: Effect.Effect<void>;
  }
>()("t3/nomior/context/Embeddings/EmbeddingWorker") {}

interface PendingChunkRow {
  readonly chunkId: NomiorChunkId;
  readonly contextualPrefix: string;
  readonly text: string;
}

export const makeEmbeddingWorker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* EmbeddingModelRegistry;

  const pendingChunks = (sourceId: NomiorSourceId | null) =>
    sql<{
      readonly chunkId: string;
      readonly contextualPrefix: string;
      readonly text: string;
    }>`
      SELECT
        c.id AS "chunkId",
        c.contextual_prefix AS "contextualPrefix",
        c.text AS "text"
      FROM nomior_chunks c
      WHERE NOT EXISTS (
        SELECT 1 FROM nomior_embeddings e
        WHERE e.chunk_id = c.id AND e.model_id = ${registry.active.id}
      )
      ${sourceId === null ? sql`` : sql`AND c.source_id = ${sourceId}`}
      ORDER BY c.source_id, c.ordinal
    `.pipe(
      Effect.mapError(toNomiorContextSqlError("EmbeddingWorker.pendingChunks")),
      Effect.map((rows) => rows as ReadonlyArray<PendingChunkRow>),
    );

  const embedBatch = (batch: ReadonlyArray<PendingChunkRow>) =>
    Effect.gen(function* () {
      const model = registry.active;
      // Contextual embedding: the deterministic prefix is part of the
      // embedded text, so "who said this, where, when" is in the vector.
      const vectors = yield* model.embed(
        batch.map((row) => `${row.contextualPrefix}\n${row.text}`),
      );
      if (vectors.length !== batch.length) {
        return yield* new NomiorEmbeddingError({
          modelId: model.id,
          detail: `model returned ${vectors.length} vectors for ${batch.length} texts`,
        });
      }
      yield* Effect.forEach(
        batch,
        (row, index) =>
          sql`
            INSERT OR REPLACE INTO nomior_embeddings (chunk_id, model_id, dim, vector)
            VALUES (${row.chunkId}, ${model.id}, ${model.dim}, ${encodeVector(vectors[index]!)})
          `.pipe(Effect.mapError(toNomiorContextSqlError("EmbeddingWorker.storeVector"))),
        { discard: true },
      );
    });

  const embedPending = (sourceId: NomiorSourceId | null) =>
    Effect.gen(function* () {
      const rows = yield* pendingChunks(sourceId);
      const batches: Array<ReadonlyArray<PendingChunkRow>> = [];
      for (let index = 0; index < rows.length; index += EMBED_BATCH_SIZE) {
        batches.push(rows.slice(index, index + EMBED_BATCH_SIZE));
      }
      yield* Effect.forEach(batches, embedBatch, {
        concurrency: EMBED_CONCURRENCY,
        discard: true,
      });
      return rows.length;
    });

  const queue = yield* Queue.unbounded<NomiorSourceId>();
  const pendingCount = yield* Ref.make(0);
  const idleWaiters = yield* Ref.make<ReadonlyArray<Deferred.Deferred<void>>>([]);

  const markDone = Effect.gen(function* () {
    const remaining = yield* Ref.updateAndGet(pendingCount, (count) => count - 1);
    if (remaining === 0) {
      const waiters = yield* Ref.getAndSet(idleWaiters, []);
      yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      });
    }
  });

  // One consumer fiber, batches inside bounded by EMBED_CONCURRENCY. The
  // fiber lives in the layer scope: closing the scope interrupts mid-batch
  // work, and the missing-embeddings query makes any dropped work resumable.
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((sourceId) =>
          embedPending(sourceId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("nomior embedding job failed", { sourceId, cause }),
            ),
            Effect.ensuring(markDone),
          ),
        ),
      ),
    ),
  );

  const enqueue = (sourceId: NomiorSourceId) =>
    Ref.update(pendingCount, (count) => count + 1).pipe(
      Effect.flatMap(() => Queue.offer(queue, sourceId)),
      Effect.asVoid,
    );

  const awaitIdle = Effect.gen(function* () {
    if ((yield* Ref.get(pendingCount)) === 0) {
      return;
    }
    const waiter = yield* Deferred.make<void>();
    yield* Ref.update(idleWaiters, (waiters) => [...waiters, waiter]);
    if ((yield* Ref.get(pendingCount)) === 0) {
      yield* Deferred.succeed(waiter, undefined);
    }
    yield* Deferred.await(waiter);
  });

  return {
    enqueue,
    drainPending: embedPending(null),
    awaitIdle,
  } satisfies EmbeddingWorker["Service"];
});

export const EmbeddingWorkerLive = Layer.effect(EmbeddingWorker, makeEmbeddingWorker);
