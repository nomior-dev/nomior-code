import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ContextBrokerLive } from "../context/ContextBroker.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import type { NomiorScope } from "../context/Model.ts";
import { ContextRetrieval } from "../context/Retrieval.ts";
import {
  MemoryCandidateId,
  MemoryCandidateStore,
  MemoryCandidateStoreLive,
  memoryCandidateId,
} from "./MemoryCandidateStore.ts";

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };

const layer = it.layer(
  MemoryCandidateStoreLive.pipe(
    Layer.provideMerge(ContextBrokerLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

describe("memoryCandidateId", () => {
  it("is content-addressed, so the same candidate offered twice is one id", () => {
    const base = {
      source: "context-tool",
      scope: projectAlpha,
      kind: "note",
      text: "Ship on Fridays.",
    } as const;
    assert.strictEqual(memoryCandidateId(base), memoryCandidateId({ ...base }));
  });

  it("separates the same sentence remembered for two scopes", () => {
    const base = { source: "context-tool", kind: "note", text: "Ship on Fridays." } as const;
    assert.notStrictEqual(
      memoryCandidateId({ ...base, scope: projectAlpha }),
      memoryCandidateId({ ...base, scope: { kind: "project", value: "proj-beta" } }),
    );
  });
});

layer("MemoryCandidateStore", (it) => {
  it.effect("offers land pending and are idempotent", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const first = yield* store.offer({
        source: "context-tool",
        scope: projectAlpha,
        kind: "note",
        text: "Ivan prefers Conventional Commits.",
      });
      const second = yield* store.offer({
        source: "context-tool",
        scope: projectAlpha,
        kind: "note",
        text: "Ivan prefers Conventional Commits.",
      });

      assert.strictEqual(first.status, "pending_approval");
      assert.isTrue(first.created);
      assert.isFalse(second.created);
      assert.strictEqual(second.candidateId, first.candidateId);

      const listed = yield* store.list();
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.status, "pending");
    }),
  );

  it.effect("approval is the only path to memory, and it ingests a retrievable source", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const retrieval = yield* ContextRetrieval;
      const worker = yield* EmbeddingWorker;

      const receipt = yield* store.offer({
        source: "context-tool",
        scope: projectAlpha,
        kind: "note",
        text: "Deployments freeze during the Kyiv office move.",
      });

      // Before approval: nothing retrievable.
      const before = yield* retrieval.search({ query: "Kyiv office move", scope: projectAlpha });
      assert.deepStrictEqual(before.snippets, []);

      const approved = yield* store.approve(receipt.candidateId);
      yield* worker.awaitIdle;

      assert.strictEqual(approved.status, "approved");
      assert.isNotNull(approved.promotedSourceId);
      assert.isNotNull(approved.resolvedAt);

      const after = yield* retrieval.search({ query: "Kyiv office move", scope: projectAlpha });
      assert.strictEqual(after.snippets[0]?.sourceId, approved.promotedSourceId);
      assert.include(after.snippets[0]?.text ?? "", "Kyiv office move");
    }),
  );

  it.effect("approving twice is a no-op, not a second memory source", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const receipt = yield* store.offer({
        source: "context-tool",
        scope: projectAlpha,
        kind: "note",
        text: "Only one copy of this should ever be ingested.",
      });
      const first = yield* store.approve(receipt.candidateId);
      const second = yield* store.approve(receipt.candidateId);
      assert.strictEqual(second.promotedSourceId, first.promotedSourceId);
    }),
  );

  it.effect("a rejected candidate stays rejected when its producer offers it again", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const receipt = yield* store.offer({
        source: "review",
        scope: null,
        originRef: "nomior/nomior-code@abc",
        kind: "finding",
        text: "Nobody wants to remember this.",
      });
      yield* store.reject(receipt.candidateId);
      yield* store.offer({
        source: "review",
        scope: null,
        originRef: "nomior/nomior-code@abc",
        kind: "finding",
        text: "Nobody wants to remember this.",
      });

      const stored = yield* store.get(receipt.candidateId);
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.status, "rejected");
    }),
  );

  it.effect("an unscoped candidate cannot be approved: nothing enters the broker unscoped", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const receipt = yield* store.offer({
        source: "review",
        scope: null,
        originRef: "nomior/nomior-code@def",
        kind: "verdict",
        text: "Review verdict approve: no findings.",
      });
      const error = yield* store.approve(receipt.candidateId).pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorMemoryCandidateScopeRequiredError");
    }),
  );

  it.effect("an unknown id is a typed miss, not a silent success", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const error = yield* store.approve(MemoryCandidateId.make("memc_missing")).pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorMemoryCandidateNotFoundError");
    }),
  );

  it.effect("list filters by status and by scope", () =>
    Effect.gen(function* () {
      const store = yield* MemoryCandidateStore;
      const keep = yield* store.offer({
        source: "context-tool",
        scope: projectAlpha,
        kind: "note",
        text: "Alpha only.",
      });
      yield* store.offer({
        source: "context-tool",
        scope: { kind: "project", value: "proj-beta" },
        kind: "note",
        text: "Beta only.",
      });
      yield* store.reject(keep.candidateId);

      // The layer is shared across this file's tests, so assert on this
      // test's own rows rather than on the whole table.
      const mine = (candidates: ReadonlyArray<{ readonly text: string }>) =>
        candidates
          .map((candidate) => candidate.text)
          .filter((text) => text === "Alpha only." || text === "Beta only.");

      assert.deepStrictEqual(
        mine(yield* store.list({ status: "pending", scope: projectAlpha })),
        [],
        "the alpha candidate was rejected, so it is not pending",
      );
      assert.deepStrictEqual(mine(yield* store.list({ scope: projectAlpha })), ["Alpha only."]);
      assert.deepStrictEqual(mine(yield* store.list({ status: "rejected" })), ["Alpha only."]);
    }),
  );
});
