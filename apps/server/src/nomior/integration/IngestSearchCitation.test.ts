/**
 * Integration: ingest → search → citation, on the REAL layer graph.
 *
 * Builds `NomiorRuntime.NomiorContextLive` (broker + memory store + the MCP
 * retrieval port) over an in-memory sqlite with the real migrations. No fakes:
 * the point is that the shipped composition works, not that the pieces do.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { NomiorScope, SourceInput } from "../context/Model.ts";
import { ContextRetrieval } from "../context/Retrieval.ts";
import { ContextRetrievalPort, type ContextScope } from "../context/RetrievalPort.ts";

const layer = it.layer(
  NomiorContextLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };
const projectBeta: NomiorScope = { kind: "project", value: "proj-beta" };

const planningMeeting: SourceInput = {
  kind: "meeting",
  externalId: "meeting-1",
  title: "Retrieval planning",
  occurredAt: "2026-08-12T10:00:00.000Z",
  scopes: [projectAlpha],
  segments: [
    { text: "We agreed the broker ships with reciprocal rank fusion.", speaker: "Ivan" },
    { text: "Olga will benchmark the reranker before September.", speaker: "Olga" },
  ],
  decisions: [{ statement: "Ship hybrid retrieval in v1.", decidedAt: "2026-08-12T10:30:00.000Z" }],
  tasks: [{ description: "Benchmark the reranker.", assignee: "Olga", status: "open" }],
};

const otherProjectMeeting: SourceInput = {
  kind: "meeting",
  externalId: "meeting-2",
  title: "Reranker benchmark",
  occurredAt: "2026-08-13T10:00:00.000Z",
  scopes: [projectBeta],
  segments: [{ text: "The reranker benchmark for the other client is unrelated." }],
};

layer("nomior integration: ingest → search → citation", (it) => {
  it.effect("a search hit carries a citation naming its source, date and chunk", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const retrieval = yield* ContextRetrieval;
      const worker = yield* EmbeddingWorker;

      const ingested = yield* ingest.ingestSource(planningMeeting);
      yield* worker.awaitIdle;

      const result = yield* retrieval.search({ query: "reranker benchmark", scope: projectAlpha });
      const top = result.snippets[0];
      assert.isDefined(top);
      assert.strictEqual(top.sourceId, ingested.sourceId);
      assert.include(top.citation, '"Retrieval planning" (meeting, 2026-08-12)');
      assert.include(top.citation, `[${top.chunkId}]`);
      // The citation's chunk id is the id an agent can fetch back.
      assert.include(ingested.chunkIds, top.chunkId);
      // Evidence span points into the canonical text the ingest returned.
      assert.strictEqual(
        ingested.canonicalText.slice(top.charStart, top.charEnd),
        top.text,
        "charStart/charEnd must address the canonical text",
      );
    }),
  );

  it.effect("scope is a hard boundary: another project's matching source never surfaces", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const retrieval = yield* ContextRetrieval;
      const worker = yield* EmbeddingWorker;

      yield* ingest.ingestSource(planningMeeting);
      yield* ingest.ingestSource(otherProjectMeeting);
      yield* worker.awaitIdle;

      const alpha = yield* retrieval.search({ query: "reranker benchmark", scope: projectAlpha });
      assert.isAbove(alpha.snippets.length, 0);
      for (const snippet of alpha.snippets) {
        assert.notInclude(snippet.text, "other client");
      }
    }),
  );

  it.effect("the MCP port resolves a searched id back to its full source", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const port = yield* ContextRetrievalPort;
      const worker = yield* EmbeddingWorker;

      yield* ingest.ingestSource(planningMeeting);
      yield* worker.awaitIdle;

      const scope = "project:proj-alpha" as ContextScope;
      const found = yield* port.search({
        query: "reciprocal rank fusion",
        scope,
        limit: 10,
        responseFormat: "concise",
      });
      const hit = found.snippets[0];
      assert.isDefined(hit);
      assert.strictEqual(hit.sourceKind, "meeting");
      // The port normalizes the engine's raw RRF score into the toolkit's [0,1].
      assert.strictEqual(hit.score, 1);
      assert.include(hit.title, "Retrieval planning");

      const source = yield* port.get({ id: hit.id, scope });
      assert.strictEqual(source.title, "Retrieval planning");
      assert.include(source.text, "reciprocal rank fusion");
    }),
  );

  it.effect("decisions and tasks extracted at ingest come back through the port", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const port = yield* ContextRetrievalPort;

      yield* ingest.ingestSource(planningMeeting);

      const items = yield* port.decisions({ project: "project:proj-alpha" as ContextScope });
      const decision = items.find((item) => item.kind === "decision");
      const task = items.find((item) => item.kind === "task");
      assert.strictEqual(decision?.statement, "Ship hybrid retrieval in v1.");
      assert.strictEqual(decision?.decidedAt, "2026-08-12T10:30:00.000Z");
      assert.strictEqual(task?.statement, "Benchmark the reranker.");
      assert.strictEqual(task?.status, "open");
    }),
  );

  it.effect("a source outside the scope reads as not found, never as a leak", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const port = yield* ContextRetrievalPort;

      const beta = yield* ingest.ingestSource(otherProjectMeeting);

      const error = yield* port
        .get({ id: beta.sourceId, scope: "project:proj-alpha" as ContextScope })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ContextSourceNotFoundError");
    }),
  );
});
