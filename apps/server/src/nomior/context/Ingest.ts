/**
 * Ingest - normalizes a source into chunks and persists it atomically.
 *
 * One transaction writes the source row, its scope bindings, all chunks (the
 * FTS index follows via triggers), and any extracted decisions/tasks with
 * their evidence spans mapped to the containing chunk. Embedding work is
 * enqueued after commit — the worker embeds in the background, never inline.
 *
 * Re-ingesting the same `(kind, externalId)` replaces the previous source in
 * the same transaction, so retrieval never sees a half-updated source.
 *
 * @module Ingest
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  computeContextualPrefix,
  planChunks,
  type ChunkPlan,
  type ChunkSourceMeta,
  type PlannedChunk,
} from "./Chunking.ts";
import { EmbeddingWorker } from "./Embeddings.ts";
import {
  chunkIdFor,
  type EvidenceSpan,
  type IngestResult,
  NomiorContextDecodeError,
  type NomiorContextError,
  type NomiorContextSqlError,
  NomiorSourceId,
  type SourceInput,
  toNomiorContextSqlError,
} from "./Model.ts";

/**
 * ContextualPrefixer - the seam for chunk context generation.
 *
 * v1 is deterministic (title · kind · date · section/time · speaker) and free.
 * An LLM-generated variant (Anthropic-style contextual retrieval: "situate
 * this chunk within the document") ships later as an alternative layer with
 * the same signature — it receives the whole canonical text precisely so a
 * model can situate each chunk. Must return one prefix per chunk, in order.
 */
export class ContextualPrefixer extends Context.Service<
  ContextualPrefixer,
  {
    readonly compute: (input: {
      readonly source: ChunkSourceMeta;
      readonly canonicalText: string;
      readonly chunks: ReadonlyArray<PlannedChunk>;
    }) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/nomior/context/Ingest/ContextualPrefixer") {}

export const ContextualPrefixerDeterministic = Layer.succeed(ContextualPrefixer, {
  compute: ({ source, chunks }) =>
    Effect.succeed(chunks.map((chunk) => computeContextualPrefix(source, chunk))),
});

export class ContextIngest extends Context.Service<
  ContextIngest,
  {
    readonly ingestSource: (input: SourceInput) => Effect.Effect<IngestResult, NomiorContextError>;
    /** Deletes the source; chunks, FTS rows, embeddings and scopes follow. */
    readonly removeSource: (sourceId: NomiorSourceId) => Effect.Effect<void, NomiorContextSqlError>;
  }
>()("t3/nomior/context/Ingest/ContextIngest") {}

const ProvenanceJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const encodeProvenance = Schema.encodeEffect(ProvenanceJson);

/** First chunk whose canonical-text range contains the evidence start. */
const chunkForEvidence = (
  plan: ChunkPlan,
  evidence: EvidenceSpan | undefined,
): PlannedChunk | null => {
  if (evidence === undefined) {
    return null;
  }
  return (
    plan.chunks.find(
      (chunk) => evidence.charStart >= chunk.charStart && evidence.charStart < chunk.charEnd,
    ) ?? null
  );
};

const makeContextIngest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const prefixer = yield* ContextualPrefixer;
  const embeddingWorker = yield* EmbeddingWorker;
  const crypto = yield* Crypto.Crypto;

  const ingestSource = Effect.fn("ContextIngest.ingestSource")(function* (input: SourceInput) {
    const sourceMeta: ChunkSourceMeta = {
      kind: input.kind,
      title: input.title,
      occurredAt: input.occurredAt,
    };
    const plan = planChunks(input.segments);
    const prefixes = yield* prefixer.compute({
      source: sourceMeta,
      canonicalText: plan.canonicalText,
      chunks: plan.chunks,
    });
    if (prefixes.length !== plan.chunks.length) {
      return yield* new NomiorContextDecodeError({
        operation: "ContextIngest.ingestSource:prefixes",
        cause: new Error(
          `prefixer returned ${prefixes.length} prefixes for ${plan.chunks.length} chunks`,
        ),
      });
    }

    const sourceId = NomiorSourceId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const ingestedAt = DateTime.formatIso(yield* DateTime.now);
    const provenanceJson = yield* encodeProvenance(input.provenance ?? {}).pipe(
      Effect.mapError(
        (cause) =>
          new NomiorContextDecodeError({
            operation: "ContextIngest.ingestSource:provenance",
            cause,
          }),
      ),
    );

    const replacedSourceId = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          let replaced: NomiorSourceId | null = null;
          if (input.externalId !== undefined) {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM nomior_sources
              WHERE kind = ${input.kind} AND external_id = ${input.externalId}
            `;
            const existingId = existing[0]?.id;
            if (existingId !== undefined) {
              replaced = NomiorSourceId.make(existingId);
              yield* sql`DELETE FROM nomior_sources WHERE id = ${existingId}`;
            }
          }

          yield* sql`
            INSERT INTO nomior_sources (id, kind, external_id, title, occurred_at, ingested_at, provenance_json)
            VALUES (
              ${sourceId},
              ${input.kind},
              ${input.externalId ?? null},
              ${input.title},
              ${input.occurredAt ?? null},
              ${ingestedAt},
              ${provenanceJson}
            )
          `;

          for (const scope of input.scopes) {
            yield* sql`
              INSERT INTO nomior_source_scopes (source_id, scope_kind, scope_value)
              VALUES (${sourceId}, ${scope.kind}, ${scope.value})
            `;
          }

          for (const [index, chunk] of plan.chunks.entries()) {
            yield* sql`
              INSERT INTO nomior_chunks (
                id, source_id, ordinal, text, contextual_prefix,
                char_start, char_end, speaker, ts_start, ts_end
              )
              VALUES (
                ${chunkIdFor(sourceId, chunk.ordinal)},
                ${sourceId},
                ${chunk.ordinal},
                ${chunk.text},
                ${prefixes[index]!},
                ${chunk.charStart},
                ${chunk.charEnd},
                ${chunk.speaker},
                ${chunk.tsStart},
                ${chunk.tsEnd}
              )
            `;
          }

          for (const [index, decision] of (input.decisions ?? []).entries()) {
            const evidenceChunk = chunkForEvidence(plan, decision.evidence);
            yield* sql`
              INSERT INTO nomior_decisions (
                id, source_id, chunk_id, statement, decided_at,
                evidence_char_start, evidence_char_end, created_at
              )
              VALUES (
                ${`${sourceId}/d${index}`},
                ${sourceId},
                ${evidenceChunk === null ? null : chunkIdFor(sourceId, evidenceChunk.ordinal)},
                ${decision.statement},
                ${decision.decidedAt ?? null},
                ${decision.evidence?.charStart ?? null},
                ${decision.evidence?.charEnd ?? null},
                ${ingestedAt}
              )
            `;
          }

          for (const [index, task] of (input.tasks ?? []).entries()) {
            const evidenceChunk = chunkForEvidence(plan, task.evidence);
            yield* sql`
              INSERT INTO nomior_tasks (
                id, source_id, chunk_id, description, assignee, due_at, status,
                evidence_char_start, evidence_char_end, created_at
              )
              VALUES (
                ${`${sourceId}/t${index}`},
                ${sourceId},
                ${evidenceChunk === null ? null : chunkIdFor(sourceId, evidenceChunk.ordinal)},
                ${task.description},
                ${task.assignee ?? null},
                ${task.dueAt ?? null},
                ${task.status ?? "open"},
                ${task.evidence?.charStart ?? null},
                ${task.evidence?.charEnd ?? null},
                ${ingestedAt}
              )
            `;
          }

          return replaced;
        }),
      )
      .pipe(Effect.mapError(toNomiorContextSqlError("ContextIngest.ingestSource:transaction")));

    yield* embeddingWorker.enqueue(sourceId);

    return {
      sourceId,
      chunkIds: plan.chunks.map((chunk) => chunkIdFor(sourceId, chunk.ordinal)),
      replacedSourceId,
      canonicalText: plan.canonicalText,
    } satisfies IngestResult;
  });

  const removeSource = (sourceId: NomiorSourceId) =>
    sql`DELETE FROM nomior_sources WHERE id = ${sourceId}`.pipe(
      Effect.mapError(toNomiorContextSqlError("ContextIngest.removeSource")),
      Effect.asVoid,
    );

  return {
    ingestSource,
    removeSource,
  } satisfies ContextIngest["Service"];
});

export const ContextIngestLive = Layer.effect(ContextIngest, makeContextIngest);
