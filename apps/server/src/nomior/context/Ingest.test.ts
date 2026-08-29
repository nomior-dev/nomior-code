import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { planChunks } from "./Chunking.ts";
import { ContextBrokerLive } from "./ContextBroker.ts";
import { EmbeddingWorker, HASH_EMBEDDING_MODEL_ID } from "./Embeddings.ts";
import { ContextIngest } from "./Ingest.ts";
import type { NomiorScope, SourceInput } from "./Model.ts";

const layer = it.layer(
  ContextBrokerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };

const meetingInput = (externalId: string, title: string): SourceInput => ({
  kind: "meeting",
  externalId,
  title,
  occurredAt: "2026-08-12T10:00:00.000Z",
  provenance: { connector: "test" },
  scopes: [projectAlpha],
  segments: [
    { text: "We agreed to ship the broker in September.", speaker: "Ivan", tsStart: 5, tsEnd: 12 },
    { text: "I will draft the migration plan tomorrow.", speaker: "Olga", tsStart: 12, tsEnd: 20 },
  ],
});

layer("ContextIngest", (it) => {
  it.effect("writes source, scopes and chunks, and keeps FTS searchable", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const sql = yield* SqlClient.SqlClient;

      const result = yield* ingest.ingestSource(meetingInput("mtg-1", "Launch sync"));
      assert.strictEqual(result.replacedSourceId, null);
      assert.isAbove(result.chunkIds.length, 0);

      const sources = yield* sql<{ readonly title: string; readonly provenance: string }>`
        SELECT title, provenance_json AS "provenance" FROM nomior_sources WHERE id = ${result.sourceId}
      `;
      assert.strictEqual(sources[0]?.title, "Launch sync");
      assert.strictEqual(sources[0]?.provenance, '{"connector":"test"}');

      const scopes = yield* sql<{ readonly scopeKind: string; readonly scopeValue: string }>`
        SELECT scope_kind AS "scopeKind", scope_value AS "scopeValue"
        FROM nomior_source_scopes WHERE source_id = ${result.sourceId}
      `;
      assert.deepStrictEqual(scopes, [{ scopeKind: "project", scopeValue: "proj-alpha" }]);

      const hits = yield* sql<{ readonly chunkId: string }>`
        SELECT c.id AS "chunkId"
        FROM nomior_chunks_fts
        JOIN nomior_chunks c ON c.rowid = nomior_chunks_fts.rowid
        WHERE nomior_chunks_fts MATCH 'september'
      `;
      assert.ok(hits.some((hit) => hit.chunkId === result.chunkIds[0]));
    }),
  );

  it.effect("stores the deterministic contextual prefix on every chunk", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const sql = yield* SqlClient.SqlClient;

      const result = yield* ingest.ingestSource(meetingInput("mtg-2", "Prefix sync"));
      const chunks = yield* sql<{ readonly contextualPrefix: string }>`
        SELECT contextual_prefix AS "contextualPrefix"
        FROM nomior_chunks WHERE source_id = ${result.sourceId}
      `;
      assert.isAbove(chunks.length, 0);
      for (const chunk of chunks) {
        assert.include(chunk.contextualPrefix, "Prefix sync");
        assert.include(chunk.contextualPrefix, "meeting");
        assert.include(chunk.contextualPrefix, "2026-08-12");
      }
    }),
  );

  it.effect("re-ingesting the same (kind, externalId) replaces the previous source", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const sql = yield* SqlClient.SqlClient;

      const first = yield* ingest.ingestSource(meetingInput("mtg-3", "Old title"));
      const second = yield* ingest.ingestSource(meetingInput("mtg-3", "New title"));
      assert.strictEqual(second.replacedSourceId, first.sourceId);

      const sources = yield* sql<{ readonly id: string; readonly title: string }>`
        SELECT id, title FROM nomior_sources WHERE kind = 'meeting' AND external_id = 'mtg-3'
      `;
      assert.strictEqual(sources.length, 1);
      assert.strictEqual(sources[0]?.title, "New title");

      const orphanChunks = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks WHERE source_id = ${first.sourceId}
      `;
      assert.strictEqual(orphanChunks[0]?.n, 0);
    }),
  );

  it.effect("maps decision and task evidence spans to the containing chunk", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const sql = yield* SqlClient.SqlClient;

      // Spans are computed the way a connector computes them: against the
      // canonical text from the exported pure `planChunks`, never against raw
      // segment texts (the canonical text carries speaker prefixes).
      const input = meetingInput("mtg-4", "Decision sync");
      const canonical = planChunks(input.segments).canonicalText;
      const decisionQuote = "ship the broker in September.";
      const taskQuote = "draft the migration plan tomorrow.";
      const decisionStart = canonical.indexOf(decisionQuote);
      const taskStart = canonical.indexOf(taskQuote);
      assert.isAbove(decisionStart, -1);
      assert.isAbove(taskStart, -1);

      const result = yield* ingest.ingestSource({
        ...input,
        decisions: [
          {
            statement: "Ship the broker in September",
            decidedAt: "2026-08-12T10:00:00.000Z",
            evidence: {
              charStart: decisionStart,
              charEnd: decisionStart + decisionQuote.length,
            },
          },
        ],
        tasks: [
          {
            description: "Draft the migration plan",
            assignee: "Olga",
            evidence: { charStart: taskStart, charEnd: taskStart + taskQuote.length },
          },
        ],
      });

      // The ingest result hands back the exact text the spans address.
      assert.strictEqual(result.canonicalText, canonical);
      assert.strictEqual(
        result.canonicalText.slice(decisionStart, decisionStart + decisionQuote.length),
        decisionQuote,
      );

      const decisions = yield* sql<{
        readonly chunkId: string | null;
        readonly evidenceCharStart: number | null;
      }>`
        SELECT chunk_id AS "chunkId", evidence_char_start AS "evidenceCharStart"
        FROM nomior_decisions WHERE source_id = ${result.sourceId}
      `;
      assert.strictEqual(decisions.length, 1);
      assert.strictEqual(decisions[0]?.chunkId, `${result.sourceId}/0`);
      assert.strictEqual(decisions[0]?.evidenceCharStart, decisionStart);

      const tasks = yield* sql<{ readonly chunkId: string | null; readonly status: string }>`
        SELECT chunk_id AS "chunkId", status FROM nomior_tasks WHERE source_id = ${result.sourceId}
      `;
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0]?.status, "open");
      // Olga's turn, so chunk 1 — the decision above came from Ivan's, chunk 0.
      // Each span lands in the chunk that actually contains it rather than in a
      // single chunk spanning both speakers.
      assert.strictEqual(tasks[0]?.chunkId, `${result.sourceId}/1`);
      assert.notStrictEqual(tasks[0]?.chunkId, decisions[0]?.chunkId);
    }),
  );

  it.effect("enqueues embedding work that lands vectors for the active model", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      const sql = yield* SqlClient.SqlClient;

      const result = yield* ingest.ingestSource(meetingInput("mtg-5", "Embedded sync"));
      yield* worker.awaitIdle;

      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_embeddings e
        JOIN nomior_chunks c ON c.id = e.chunk_id
        WHERE c.source_id = ${result.sourceId} AND e.model_id = ${HASH_EMBEDDING_MODEL_ID}
      `;
      assert.strictEqual(rows[0]?.n, result.chunkIds.length);
    }),
  );

  it.effect("removeSource deletes chunks, scopes, embeddings and FTS rows", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      const sql = yield* SqlClient.SqlClient;

      const result = yield* ingest.ingestSource(meetingInput("mtg-6", "Removable unique1token"));
      yield* worker.awaitIdle;
      yield* ingest.removeSource(result.sourceId);

      const counts = yield* sql<{ readonly n: number }>`
        SELECT
          (SELECT count(*) FROM nomior_chunks WHERE source_id = ${result.sourceId})
          + (SELECT count(*) FROM nomior_source_scopes WHERE source_id = ${result.sourceId})
          + (SELECT count(*) FROM nomior_embeddings WHERE chunk_id IN (${result.chunkIds[0]!}))
          AS n
      `;
      assert.strictEqual(counts[0]?.n, 0);

      const ftsHits = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM nomior_chunks_fts WHERE nomior_chunks_fts MATCH 'unique1token'
      `;
      assert.strictEqual(ftsHits[0]?.n, 0);
    }),
  );
});
