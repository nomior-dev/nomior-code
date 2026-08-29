/**
 * Integration: the two memory-candidate producers write to ONE store.
 *
 * `context_remember` (MCP toolkit → `ContextRetrievalPortLive`) and the review
 * engine's `MemoryCandidateSink` (→ `MemoryCandidateSinkLive`) are wired
 * independently and must not be able to drift into two stores. This builds
 * both paths on one layer graph, offers through each, and reads them back
 * through the single `MemoryCandidateStore` a UI candidate list reads.
 *
 * Then it approves one and proves approval — and only approval — turns a
 * candidate into retrievable memory.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import type { NomiorScope } from "../context/Model.ts";
import { ContextRetrieval } from "../context/Retrieval.ts";
import { ContextRetrievalPort, type ContextScope } from "../context/RetrievalPort.ts";
import { MemoryCandidateId, MemoryCandidateStore } from "../memory/MemoryCandidateStore.ts";
import { MemoryCandidateSinkLive } from "../memory/ReviewSinkLive.ts";
import { MemoryCandidateSink } from "../review/MemoryCandidates.ts";

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };
const portScope = "project:proj-alpha" as ContextScope;

const layer = it.layer(
  MemoryCandidateSinkLive.pipe(
    Layer.provideMerge(NomiorContextLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

layer("nomior integration: one memory-candidate store, two producers", (it) => {
  it.effect("context_remember and a review finding land in the same list, both pending", () =>
    Effect.gen(function* () {
      const port = yield* ContextRetrievalPort;
      const sink = yield* MemoryCandidateSink;
      const store = yield* MemoryCandidateStore;

      const receipt = yield* port.remember({
        text: "Anarlog transcripts are the source of truth for meeting decisions.",
        scope: portScope,
      });
      assert.strictEqual(receipt.status, "pending_approval");

      yield* sink.offer({
        source: "review",
        repo: "nomior/nomior-code",
        headSha: "deadbee",
        kind: "finding",
        text: "The retrieval port swallowed a scope error.",
        severity: "medium",
      });

      const candidates = yield* store.list();
      const bySource = new Map(candidates.map((candidate) => [candidate.source, candidate]));
      assert.strictEqual(candidates.length, 2, "one store, not one per producer");
      assert.strictEqual(bySource.get("context-tool")?.status, "pending");
      assert.strictEqual(bySource.get("review")?.status, "pending");
      assert.strictEqual(bySource.get("review")?.severity, "medium");
      assert.strictEqual(bySource.get("review")?.originRef, "nomior/nomior-code@deadbee");
      // Nothing auto-promotes: neither producer can write an approved row.
      for (const candidate of candidates) {
        assert.isNull(candidate.promotedSourceId);
      }
    }),
  );

  it.effect("approval, and nothing else, makes a candidate retrievable", () =>
    Effect.gen(function* () {
      const port = yield* ContextRetrievalPort;
      const store = yield* MemoryCandidateStore;
      const retrieval = yield* ContextRetrieval;
      const worker = yield* EmbeddingWorker;

      const receipt = yield* port.remember({
        text: "Invoices for Acme go out on the first working day.",
        scope: portScope,
      });

      const before = yield* retrieval.search({ query: "Acme invoices", scope: projectAlpha });
      for (const snippet of before.snippets) {
        assert.notInclude(snippet.text, "first working day");
      }

      const approved = yield* store.approve(MemoryCandidateId.make(receipt.candidateId));
      yield* worker.awaitIdle;
      assert.strictEqual(approved.status, "approved");

      const after = yield* retrieval.search({ query: "Acme invoices", scope: projectAlpha });
      const memory = after.snippets.find((snippet) => snippet.sourceKind === "memory");
      assert.isDefined(memory);
      assert.include(memory.text, "first working day");
      assert.strictEqual(memory.sourceId, approved.promotedSourceId);
      // Promoted memory is citable like any other source.
      assert.include(memory.citation, "(memory");
    }),
  );

  it.effect("an approved memory is scoped: it stays out of another project's search", () =>
    Effect.gen(function* () {
      const retrieval = yield* ContextRetrieval;
      const other = yield* retrieval.search({
        query: "Acme invoices",
        scope: { kind: "project", value: "proj-beta" },
      });
      assert.deepStrictEqual(other.snippets, []);
    }),
  );
});
