import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Tool, Toolkit } from "effect/unstable/ai";

import * as RetrievalPort from "../../../nomior/context/RetrievalPort.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  clampBudgetTokens,
  CONTEXT_SEARCH_DEFAULT_BUDGET_TOKENS,
  CONTEXT_SEARCH_MAX_BUDGET_TOKENS,
  CONTEXT_SEARCH_MIN_BUDGET_TOKENS,
  estimateTokenCount,
  NomiorContextToolkitHandlersLive,
} from "./handlers.ts";
import { NomiorContextToolkit } from "./tools.ts";

type ContextTools =
  typeof NomiorContextToolkit extends Toolkit.Toolkit<infer Tools> ? Tools : never;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const longBody = Array.from(
  { length: 400 },
  (_, index) => `Sentence ${index} about the retrieval budget policy and evidence handling.`,
).join(" ");

const sources: ReadonlyArray<RetrievalPort.ContextSourceRecord> = [
  {
    id: "meeting_kickoff",
    scope: "project:nomior",
    sourceKind: "meeting",
    title: "Kickoff",
    text: `Decisions about retrieval budget were made here. ${longBody}`,
    date: "2026-08-10",
  },
  {
    id: "doc_secrets",
    scope: "project:nomior",
    sourceKind: "document",
    title: "Deploy notes",
    text: "To deploy, export API_KEY=super-secret-value-1234 and run the script. The budget for retrieval is unrelated.",
    date: "2026-08-11",
  },
  {
    id: "doc_budget_2",
    scope: "project:nomior",
    sourceKind: "document",
    title: "Budget follow-up",
    text: `More retrieval budget discussion. ${longBody}`,
    date: "2026-08-12",
  },
  {
    id: "doc_other_scope",
    scope: "project:juna",
    sourceKind: "document",
    title: "Other project",
    text: "Budget retrieval content that must never appear for project:nomior.",
  },
  {
    // Cyrillic weighs ~2 chars/token, so a single snippet of this source can
    // exceed the floor budget on its own - exercises the single-hit fallback.
    id: "meeting_cyrillic",
    scope: "project:nomior",
    sourceKind: "meeting",
    title: `Планёрка по бюджету поиска — ${"очень ".repeat(28)}длинное название`,
    text: Array.from(
      { length: 40 },
      (_, index) => `Пункт ${index} обсуждения бюджета поиска и правил усечения выдачи.`,
    ).join(" "),
    date: "2026-08-13",
  },
];

const seed: RetrievalPort.InMemoryContextSeed = {
  sources,
  decisions: [
    {
      id: "dec_fork",
      project: "project:nomior",
      kind: "decision",
      statement: "Fork T3 Code; keep the diff additive.",
      decidedAt: "2026-08-29",
      evidence: [{ sourceId: "meeting_kickoff", span: { start: 0, end: 40 } }],
    },
  ],
  threadScopes: { "thread-1": "project:nomior" },
};

const makeTestLayer = (portLayer: Layer.Layer<RetrievalPort.ContextRetrievalPort>) =>
  Layer.mergeAll(
    NomiorContextToolkitHandlersLive,
    portLayer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
  );

const runTool = <Name extends keyof ContextTools>(
  name: Name,
  params: Tool.Parameters<ContextTools[Name]>,
) =>
  Effect.gen(function* () {
    const built = yield* NomiorContextToolkit;
    const handled = yield* built
      .handle(name, params)
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
    // failureMode is "error", so a handler failure never reaches `result`.
    return handled.result as Tool.Success<ContextTools[Name]>;
  });

describe("context_search", () => {
  it.effect("returns cited snippets with evidence spans and dates inside the budget", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "retrieval budget decisions",
        scope: "project:nomior",
      });
      expect(result.scope).toBe("project:nomior");
      expect(result.budgetTokens).toBe(CONTEXT_SEARCH_DEFAULT_BUDGET_TOKENS);
      expect(result.snippets.length).toBeGreaterThan(0);
      for (const snippet of result.snippets) {
        expect(snippet.id.length).toBeGreaterThan(0);
        expect(snippet.span).toBeDefined();
        expect(snippet.score).toBeGreaterThan(0);
      }
      expect(result.snippets[0]?.date).toBeDefined();
      // Every id must be drill-down-able at full fidelity.
      const first = result.snippets[0];
      if (first) {
        const fetched = yield* runTool("context_get", { id: first.id });
        expect(fetched.id).toBe(first.id);
      }
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("enforces the token budget server-side and steers to narrower queries", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "retrieval budget",
        scope: "project:nomior",
        budget_tokens: CONTEXT_SEARCH_MIN_BUDGET_TOKENS,
        response_format: "detailed",
      });
      expect(result.budgetTokens).toBe(CONTEXT_SEARCH_MIN_BUDGET_TOKENS);
      expect(result.snippets.length).toBeLessThan(result.totalMatches);
      expect(result.truncated).toBe(true);
      expect(result.guidance).toContain("Narrow the query");
      const spent = result.snippets.reduce(
        (total, snippet) => total + Math.ceil((snippet.text.length + snippet.title.length) / 4),
        0,
      );
      expect(spent).toBeLessThanOrEqual(CONTEXT_SEARCH_MIN_BUDGET_TOKENS);
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("clamps an oversized requested budget to the server cap", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "retrieval budget",
        scope: "project:nomior",
        budget_tokens: 99_000,
      });
      expect(result.budgetTokens).toBe(CONTEXT_SEARCH_MAX_BUDGET_TOKENS);
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("uses the thread's scope when none is passed", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", { query: "retrieval budget" });
      expect(result.scope).toBe("project:nomior");
      expect(result.snippets.every((snippet) => snippet.id !== "doc_other_scope")).toBe(true);
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("fails closed when no scope is passed and none is resolvable", () =>
    Effect.gen(function* () {
      const error = yield* runTool("context_search", { query: "retrieval budget" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("ContextScopeRequiredError");
      expect(error.message).toContain("scope");
    }).pipe(
      Effect.provide(makeTestLayer(RetrievalPort.layerInMemory({ ...seed, threadScopes: {} }))),
    ),
  );

  it.effect("never returns secrets in snippets", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "deploy script",
        scope: "project:nomior",
      });
      const rendered = result.snippets
        .map((snippet) => `${snippet.title}\n${snippet.text}`)
        .join("\n");
      expect(rendered).not.toContain("super-secret-value-1234");
      expect(rendered).toContain("[redacted:assigned-credential]");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("trims a single over-budget hit to fit and reports it as truncated", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "бюджета поиска",
        scope: "project:nomior",
        budget_tokens: CONTEXT_SEARCH_MIN_BUDGET_TOKENS,
        response_format: "detailed",
      });
      expect(result.totalMatches).toBe(1);
      expect(result.snippets).toHaveLength(1);
      const snippet = result.snippets[0]!;
      // Titles are budget-charged, so they are capped like snippet text.
      expect(snippet.title.length).toBeLessThanOrEqual(160);
      const cost = 24 + estimateTokenCount(snippet.text) + estimateTokenCount(snippet.title);
      expect(cost).toBeLessThanOrEqual(CONTEXT_SEARCH_MIN_BUDGET_TOKENS);
      // The lone hit was clipped by the budget, so the agent must be told.
      expect(result.truncated).toBe(true);
      expect(result.guidance).toContain("Narrow the query");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );
});

describe("scope authorization", () => {
  const grantSeed: RetrievalPort.InMemoryContextSeed = {
    ...seed,
    threadScopeGrants: { "thread-1": [] },
  };

  it.effect("denies an explicit scope the thread is not granted, on every scoped tool", () =>
    Effect.gen(function* () {
      const searchError = yield* runTool("context_search", {
        query: "retrieval budget",
        scope: "project:juna",
      }).pipe(Effect.flip);
      expect(searchError._tag).toBe("ContextScopeDeniedError");

      const decisionsError = yield* runTool("context_decisions", {
        project: "project:juna",
      }).pipe(Effect.flip);
      expect(decisionsError._tag).toBe("ContextScopeDeniedError");

      const rememberError = yield* runTool("context_remember", {
        text: "should never be stored",
        scope: "project:juna",
      }).pipe(Effect.flip);
      expect(rememberError._tag).toBe("ContextScopeDeniedError");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(grantSeed)))),
  );

  it.effect("still allows the thread's own scope when named explicitly", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_search", {
        query: "retrieval budget",
        scope: "project:nomior",
      });
      expect(result.scope).toBe("project:nomior");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(grantSeed)))),
  );
});

describe("context_get", () => {
  it.effect("caps unexpanded reads and points at expand", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_get", { id: "meeting_kickoff" });
      expect(result.text.length).toBeLessThanOrEqual(8_000);
      expect(result.truncated).toBe(true);
      expect(result.guidance).toContain("expand");
      const expanded = yield* runTool("context_get", { id: "meeting_kickoff", expand: true });
      expect(expanded.text.length).toBeGreaterThan(result.text.length);
      expect(expanded.truncated).toBe(false);
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("redacts secrets even at full fidelity", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_get", { id: "doc_secrets" });
      expect(result.text).not.toContain("super-secret-value-1234");
      expect(result.text).toContain("[redacted:assigned-credential]");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("does not resolve ids outside the thread scope", () =>
    Effect.gen(function* () {
      const error = yield* runTool("context_get", { id: "doc_other_scope" }).pipe(Effect.flip);
      expect(error._tag).toBe("ContextSourceNotFoundError");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );
});

describe("context_decisions", () => {
  it.effect("returns structured decisions with evidence ids", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_decisions", { project: "project:nomior" });
      expect(result.project).toBe("project:nomior");
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]?.evidence[0]?.sourceId).toBe("meeting_kickoff");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );
});

describe("context_remember", () => {
  it.effect("returns a pending candidate and states that approval is required", () =>
    Effect.gen(function* () {
      const result = yield* runTool("context_remember", {
        text: "Ivan prefers conventional commits",
        scope: "project:nomior",
      });
      expect(result.candidateId.length).toBeGreaterThan(0);
      expect(result.status).toBe("pending_approval");
      expect(result.note).toContain("approves");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerInMemory(seed)))),
  );

  it.effect("redacts secrets before the text reaches the candidate store", () =>
    Effect.gen(function* () {
      const stored: Array<RetrievalPort.ContextRememberRequest> = [];
      const unavailable = () =>
        Effect.fail(new RetrievalPort.ContextUnavailableError({ reason: "unused in this test" }));
      const capturingPort = Layer.succeed(
        RetrievalPort.ContextRetrievalPort,
        RetrievalPort.ContextRetrievalPort.of({
          search: unavailable,
          get: unavailable,
          decisions: unavailable,
          remember: (request) =>
            Effect.sync(() => {
              stored.push(request);
              return { candidateId: "memc_capture", status: "pending_approval" as const };
            }),
          defaultScopeForThread: () => Effect.succeed(Option.none()),
          authorizeScope: () => Effect.void,
        }),
      );
      const result = yield* runTool("context_remember", {
        text: "Deploy uses api_key=super-secret-value-1234 for now",
        scope: "project:nomior",
      }).pipe(Effect.provide(makeTestLayer(capturingPort)));
      expect(result.status).toBe("pending_approval");
      expect(stored).toHaveLength(1);
      expect(stored[0]?.text).not.toContain("super-secret-value-1234");
      expect(stored[0]?.text).toContain("[redacted:assigned-credential]");
    }),
  );
});

describe("unwired engine", () => {
  it.effect("fails closed with ContextUnavailableError", () =>
    Effect.gen(function* () {
      const error = yield* runTool("context_search", {
        query: "anything",
        scope: "project:nomior",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("ContextUnavailableError");
    }).pipe(Effect.provide(makeTestLayer(RetrievalPort.layerUnavailable))),
  );
});

describe("clampBudgetTokens", () => {
  it("applies default, floor, and cap", () => {
    expect(clampBudgetTokens(undefined)).toBe(CONTEXT_SEARCH_DEFAULT_BUDGET_TOKENS);
    expect(clampBudgetTokens(1)).toBe(CONTEXT_SEARCH_MIN_BUDGET_TOKENS);
    expect(clampBudgetTokens(99_000)).toBe(CONTEXT_SEARCH_MAX_BUDGET_TOKENS);
    expect(clampBudgetTokens(1_000)).toBe(1_000);
  });
});

describe("estimateTokenCount", () => {
  it("charges ASCII at ~4 chars per token and Cyrillic at ~2", () => {
    expect(estimateTokenCount("a".repeat(400))).toBe(100);
    expect(estimateTokenCount("б".repeat(400))).toBe(200);
  });
});
