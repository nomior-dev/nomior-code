import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ContextBrokerLive } from "./ContextBroker.ts";
import { EmbeddingWorker } from "./Embeddings.ts";
import { ContextIngest } from "./Ingest.ts";
import {
  NomiorChunkId,
  NomiorSourceId,
  type NomiorScope,
  type RetrievedSnippet,
  type SourceInput,
} from "./Model.ts";
import {
  approxTokens,
  buildMatchExpression,
  ContextRetrieval,
  DEFAULT_BUDGET_TOKENS,
  enforceBudget,
  formatCitation,
  parseCitation,
  rrfFuse,
  truncationNotice,
} from "./Retrieval.ts";

// ===============================
// Pure pieces
// ===============================

describe("rrfFuse", () => {
  it("computes reciprocal-rank scores with k=60", () => {
    const fused = rrfFuse([["a", "b"], ["b"]]);
    assert.deepStrictEqual(
      fused.map((entry) => entry.id),
      ["b", "a"],
    );
    assert.approximately(fused[0]!.score, 1 / 62 + 1 / 61, 1e-12);
    assert.approximately(fused[1]!.score, 1 / 61, 1e-12);
  });

  it("rewards presence in both rankings over a single top rank", () => {
    const fused = rrfFuse([["solo", "both"], ["both"]]);
    assert.strictEqual(fused[0]!.id, "both");
  });

  it("breaks exact ties deterministically by id", () => {
    const fused = rrfFuse([["b"], ["a"]]);
    assert.deepStrictEqual(
      fused.map((entry) => entry.id),
      ["a", "b"],
    );
  });
});

describe("buildMatchExpression", () => {
  it("quotes tokens as prefix terms joined with OR", () => {
    assert.strictEqual(
      buildMatchExpression("Deploy the Broker!"),
      '"deploy"* OR "the"* OR "broker"*',
    );
  });

  it("handles Cyrillic and strips punctuation", () => {
    assert.strictEqual(buildMatchExpression("запуск, сентябрь?"), '"запуск"* OR "сентябрь"*');
  });

  it("returns null when nothing is indexable", () => {
    assert.strictEqual(buildMatchExpression("!!! ---"), null);
  });
});

const snippet = (id: string, textLength: number, prefixLength = 4): RetrievedSnippet => ({
  sourceId: NomiorSourceId.make("s"),
  chunkId: NomiorChunkId.make(id),
  sourceKind: "meeting",
  title: "T",
  contextualPrefix: "p".repeat(prefixLength),
  text: "x".repeat(textLength),
  charStart: 0,
  charEnd: textLength,
  ordinal: 0,
  speaker: null,
  occurredAt: null,
  score: 1,
  citation: "c",
});

describe("enforceBudget", () => {
  it("keeps everything when it fits", () => {
    const result = enforceBudget([snippet("a", 400), snippet("b", 400)], 1000);
    assert.strictEqual(result.snippets.length, 2);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.usedTokens, 2 * (100 + 1));
  });

  it("drops the tail once the budget is spent", () => {
    const result = enforceBudget([snippet("a", 400), snippet("b", 400), snippet("c", 400)], 210);
    assert.deepStrictEqual(
      result.snippets.map((entry) => entry.chunkId),
      ["a", "b"],
    );
    assert.strictEqual(result.truncated, true);
    assert.isAtMost(result.usedTokens, 210);
  });

  it("cuts the first snippet rather than returning nothing", () => {
    const result = enforceBudget([snippet("a", 4000)], 100);
    assert.strictEqual(result.snippets.length, 1);
    assert.strictEqual(result.truncated, true);
    assert.isAtMost(result.usedTokens, 100);
    assert.isBelow(result.snippets[0]!.text.length, 4000);
  });

  it("returns nothing when even the prefix exceeds the budget", () => {
    // Prefix alone is 100 tokens against a 10-token budget: a prefix-only
    // snippet would blow the budget, so the caller gets the notice instead.
    const result = enforceBudget([snippet("a", 4000, 400)], 10);
    assert.strictEqual(result.snippets.length, 0);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.usedTokens, 0);
  });

  it("approxTokens is chars over four, rounded up", () => {
    assert.strictEqual(approxTokens(""), 0);
    assert.strictEqual(approxTokens("abcde"), 2);
  });
});

describe("truncationNotice", () => {
  it("steers the caller toward a narrower query", () => {
    const notice = truncationNotice(1800);
    assert.include(notice, "truncated");
    assert.include(notice, "narrow your query");
    assert.include(notice, "1800");
  });
});

describe("formatCitation", () => {
  it("renders title, kind, date, section and chunk id", () => {
    assert.strictEqual(
      formatCitation({
        title: "Launch sync",
        sourceKind: "meeting",
        occurredAt: "2026-08-12T10:00:00.000Z",
        ordinal: 2,
        chunkId: "src/2",
      }),
      '"Launch sync" (meeting, 2026-08-12) §3 [src/2]',
    );
  });
});

describe("parseCitation", () => {
  const roundTrip = (title: string, occurredAt: string | null) => {
    const parsed = parseCitation(
      formatCitation({ title, sourceKind: "document", occurredAt, ordinal: 4, chunkId: "src/4" }),
    );
    assert.deepStrictEqual(parsed, { title, ordinal: 4, chunkId: "src/4" });
  };

  it("reads back a citation it formatted", () => {
    roundTrip("Launch sync", "2026-08-12T10:00:00.000Z");
  });

  it("reads back an undated citation", () => {
    roundTrip("Launch sync", null);
  });

  it("keeps a title that contains the citation's own punctuation", () => {
    roundTrip('Mix review — "EP master" (final) §2 [notes]', "2026-08-12T10:00:00.000Z");
  });

  it("returns null for a string it did not format", () => {
    assert.strictEqual(parseCitation("Launch sync"), null);
  });
});

// ===============================
// Integrated search
// ===============================

const layer = it.layer(
  ContextBrokerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const scopeOf = (value: string): NomiorScope => ({ kind: "project", value });

const meeting = (options: {
  readonly externalId: string;
  readonly title: string;
  readonly project: string;
  readonly segments: ReadonlyArray<{ readonly text: string; readonly speaker?: string }>;
  readonly kind?: SourceInput["kind"];
  readonly occurredAt?: string;
}): SourceInput => ({
  kind: options.kind ?? "meeting",
  externalId: options.externalId,
  title: options.title,
  occurredAt: options.occurredAt ?? "2026-08-12T10:00:00.000Z",
  scopes: [scopeOf(options.project)],
  segments: options.segments.map((segment) => ({
    text: segment.text,
    ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }),
  })),
});

const seedCorpus = Effect.gen(function* () {
  const ingest = yield* ContextIngest;
  const worker = yield* EmbeddingWorker;

  const alpha = yield* ingest.ingestSource(
    meeting({
      externalId: "ret-alpha-launch",
      title: "Alpha launch sync",
      project: "proj-alpha",
      segments: [
        { text: "We agreed to move the launch date to September.", speaker: "Ivan" },
        { text: "The staging cluster quota needs a bump before rollout.", speaker: "Olga" },
      ],
    }),
  );
  const alphaDoc = yield* ingest.ingestSource(
    meeting({
      externalId: "ret-alpha-runbook",
      title: "Alpha runbook",
      project: "proj-alpha",
      kind: "document",
      occurredAt: "2026-07-01T00:00:00.000Z",
      segments: [
        { text: "Rollback procedure: restore the database snapshot, then redeploy." },
        { text: "The staging cluster quota is managed by the platform team." },
      ],
    }),
  );
  const beta = yield* ingest.ingestSource(
    meeting({
      externalId: "ret-beta-launch",
      title: "Beta launch sync",
      project: "proj-beta",
      segments: [{ text: "Beta will also move its launch date to September.", speaker: "Mark" }],
    }),
  );
  yield* worker.awaitIdle;
  return { alpha, alphaDoc, beta };
});

layer("ContextRetrieval.search", (it) => {
  it.effect("returns cited snippets with evidence spans for a scoped query", () =>
    Effect.gen(function* () {
      const { alpha } = yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;

      const result = yield* retrieval.search({
        query: "launch date September",
        scope: scopeOf("proj-alpha"),
      });

      assert.isAbove(result.snippets.length, 0);
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.notice, null);
      assert.strictEqual(result.budgetTokens, DEFAULT_BUDGET_TOKENS);

      const top = result.snippets[0]!;
      assert.strictEqual(top.sourceId, alpha.sourceId);
      assert.include(top.text, "September");
      assert.include(top.citation, '"Alpha launch sync" (meeting, 2026-08-12)');
      assert.include(top.citation, top.chunkId);
      assert.isAtLeast(top.charEnd, top.charStart);
      assert.strictEqual(top.occurredAt, "2026-08-12T10:00:00.000Z");
    }),
  );

  it.effect("scope isolation: a query in project A never returns project B chunks", () =>
    Effect.gen(function* () {
      const { alpha, beta } = yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;

      // Both projects mention the same words; each scope only sees its own.
      const alphaResult = yield* retrieval.search({
        query: "launch date September",
        scope: scopeOf("proj-alpha"),
      });
      assert.isAbove(alphaResult.snippets.length, 0);
      for (const found of alphaResult.snippets) {
        assert.notStrictEqual(found.sourceId, beta.sourceId);
      }

      const betaResult = yield* retrieval.search({
        query: "launch date September",
        scope: scopeOf("proj-beta"),
      });
      assert.isAbove(betaResult.snippets.length, 0);
      for (const found of betaResult.snippets) {
        assert.strictEqual(found.sourceId, beta.sourceId);
        assert.notStrictEqual(found.sourceId, alpha.sourceId);
      }

      const emptyScope = yield* retrieval.search({
        query: "launch date September",
        scope: scopeOf("proj-gamma"),
      });
      assert.strictEqual(emptyScope.snippets.length, 0);
    }),
  );

  it.effect("filters by source kind and by since date", () =>
    Effect.gen(function* () {
      const { alpha, alphaDoc } = yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;

      const docsOnly = yield* retrieval.search({
        query: "staging cluster quota",
        scope: scopeOf("proj-alpha"),
        kinds: ["document"],
      });
      assert.isAbove(docsOnly.snippets.length, 0);
      for (const found of docsOnly.snippets) {
        assert.strictEqual(found.sourceId, alphaDoc.sourceId);
      }

      const recentOnly = yield* retrieval.search({
        query: "staging cluster quota",
        scope: scopeOf("proj-alpha"),
        since: "2026-08-01T00:00:00.000Z",
      });
      assert.isAbove(recentOnly.snippets.length, 0);
      for (const found of recentOnly.snippets) {
        assert.strictEqual(found.sourceId, alpha.sourceId);
      }
    }),
  );

  it.effect("enforces the token budget and steers toward narrower queries", () =>
    Effect.gen(function* () {
      yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;

      const result = yield* retrieval.search({
        query: "launch staging cluster quota rollback snapshot",
        scope: scopeOf("proj-alpha"),
        budgetTokens: 30,
      });
      assert.strictEqual(result.truncated, true);
      assert.isAtMost(result.usedTokens, 30);
      assert.ok(result.notice !== null);
      assert.include(result.notice!, "truncated");
      assert.include(result.notice!, "narrow your query");
    }),
  );

  it.effect("never returns whole raw transcripts", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      const retrieval = yield* ContextRetrieval;

      const longMeeting = meeting({
        externalId: "ret-long",
        title: "Marathon planning",
        project: "proj-long",
        segments: Array.from({ length: 120 }, (_, index) => ({
          text: `Turn ${index}: the marathon migration plan covers step ${index} of the rollout in detail. `.repeat(
            3,
          ),
          speaker: index % 2 === 0 ? "Ivan" : "Olga",
        })),
      });
      yield* ingest.ingestSource(longMeeting);
      yield* worker.awaitIdle;

      const result = yield* retrieval.search({
        query: "marathon migration plan rollout",
        scope: scopeOf("proj-long"),
      });

      assert.isAbove(result.snippets.length, 0);
      const totalChars = result.snippets.reduce(
        (sum, found) => sum + found.text.length + found.contextualPrefix.length,
        0,
      );
      // The full transcript is far larger than the budget allows through.
      assert.isAtMost(result.usedTokens, DEFAULT_BUDGET_TOKENS);
      assert.isAtMost(totalChars, DEFAULT_BUDGET_TOKENS * 4 + 4);
      for (const found of result.snippets) {
        assert.isAtMost(found.text.length, 2000);
      }
    }),
  );

  it.effect("returns an empty result for a query with no indexable tokens", () =>
    Effect.gen(function* () {
      yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;
      const result = yield* retrieval.search({
        query: "£$%^&*",
        scope: scopeOf("proj-alpha"),
      });
      assert.strictEqual(result.snippets.length, 0);
      assert.strictEqual(result.truncated, false);
    }),
  );

  it.effect("finds RU content with an inflected RU query via fusion", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      const retrieval = yield* ContextRetrieval;

      const ruMeeting = yield* ingest.ingestSource(
        meeting({
          externalId: "ret-ru",
          title: "Синк по запуску",
          project: "proj-ru",
          segments: [
            { text: "Мы решили перенести запуск на сентябрь.", speaker: "Иван" },
            { text: "Бюджет на инфраструктуру утвердим отдельно.", speaker: "Ольга" },
          ],
        }),
      );
      yield* worker.awaitIdle;

      const result = yield* retrieval.search({
        query: "когда запуск?",
        scope: scopeOf("proj-ru"),
      });
      assert.isAbove(result.snippets.length, 0);
      assert.strictEqual(result.snippets[0]!.sourceId, ruMeeting.sourceId);
      assert.include(result.snippets[0]!.text, "сентябрь");
    }),
  );
});

// ===============================
// Rerank hook
// ===============================

import { ContextRetrievalLive, Reranker } from "./Retrieval.ts";
import { EmbeddingModelRegistryDefault, EmbeddingWorkerLive } from "./Embeddings.ts";
import { ContextIngestLive, ContextualPrefixerDeterministic } from "./Ingest.ts";

const reversingRerankerLayer = it.layer(
  Layer.mergeAll(ContextIngestLive, ContextRetrievalLive).pipe(
    Layer.provideMerge(EmbeddingWorkerLive),
    Layer.provide(
      Layer.mergeAll(
        EmbeddingModelRegistryDefault,
        ContextualPrefixerDeterministic,
        Layer.succeed(Reranker, {
          rerank: (_query, candidates) => Effect.succeed(candidates.toReversed()),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

reversingRerankerLayer("Reranker hook", (it) => {
  it.effect("runs between fusion and budget enforcement", () =>
    Effect.gen(function* () {
      const { alpha } = yield* seedCorpus;
      const retrieval = yield* ContextRetrieval;

      const result = yield* retrieval.search({
        query: "launch date September",
        scope: scopeOf("proj-alpha"),
      });
      assert.isAbove(result.snippets.length, 1);
      // With the reversing reranker the fusion winner lands last.
      const last = result.snippets[result.snippets.length - 1]!;
      assert.strictEqual(last.sourceId, alpha.sourceId);
      assert.include(last.text, "September");
    }),
  );
});
