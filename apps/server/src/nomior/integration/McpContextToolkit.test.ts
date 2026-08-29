/**
 * Integration: the MCP context tools answering from the real broker, through
 * the app's own `McpHttpServer.layer`.
 *
 * `mcp/toolkits/nomior/registration.test.ts` proves the tools are registered
 * and their port is provided. This file proves the round trip: ingest a source,
 * then have `context_search` / `context_get` / `context_remember` served over
 * the MCP call path find it.
 *
 * `NomiorContextLive` is merged alongside `McpHttpServer.layer` so the test can
 * ingest. Both sit on the one memoized `SqlitePersistenceMemory`, so the
 * toolkit reads the same tables the test wrote — which is the coupling under
 * test.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import {
  CONTEXT_GET_EXPANDED_MAX_CHARS,
  CONTEXT_SEARCH_MAX_BUDGET_TOKENS,
  estimateTokenCount,
} from "../../mcp/toolkits/nomior/handlers.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { NomiorScope, SourceInput } from "../context/Model.ts";

const threadId = ThreadId.make("thread-nomior-integration");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-nomior-integration"),
  threadId,
  providerSessionId: "provider-session-nomior-integration",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "nomior-integration", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const McpSessionRegistryStub = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("unused in the integration test"),
    resolve: () => Effect.sync(() => undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const layer = it.layer(
  Layer.mergeAll(McpHttpServer.layer, NomiorContextLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        HttpRouter.layer,
        McpSessionRegistryStub,
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };
const scope = "project:proj-alpha";

const source: SourceInput = {
  kind: "meeting",
  externalId: "mcp-1",
  title: "Roadmap sync",
  occurredAt: "2026-08-20T09:00:00.000Z",
  scopes: [projectAlpha],
  segments: [
    { text: "We are cutting the desktop rebrand from the September release.", speaker: "Ivan" },
  ],
};

/**
 * The port reads a thread's default scope from upstream's own thread
 * projection, so a thread created in the normal UI needs no extra setup. This
 * seeds the row a real session would already have.
 */
const seedThreadProjection = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    INSERT OR IGNORE INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectAlpha.value}, 'Roadmap', ${"2026-08-20T09:00:00.000Z"}, ${"2026-08-20T09:00:00.000Z"})
  `,
);

/** Concatenated text of a tool result's content blocks. */
const resultText = (result: { readonly content: ReadonlyArray<unknown> }): string =>
  result.content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { readonly text: unknown }).text)
        : "",
    )
    .join("\n");

const callTool = (
  name: string,
  args: Record<string, unknown>,
  as: McpInvocationContext.McpInvocationScope = invocation,
) =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, as),
        Effect.provideService(McpSchema.McpServerClient, client),
      ),
  );

/** A session whose thread has no `projection_threads` row, hence no scope. */
const unprojectedInvocation: McpInvocationContext.McpInvocationScope = {
  ...invocation,
  threadId: ThreadId.make("thread-nomior-unprojected"),
};

layer("nomior integration: MCP context tools over the real broker", (it) => {
  it.effect("context_search finds an ingested source and context_get expands it", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      yield* ingest.ingestSource(source);
      yield* worker.awaitIdle;

      const searched = yield* callTool("context_search", { query: "desktop rebrand", scope });
      assert.isFalse(searched.isError);
      const searchResult = searched.structuredContent as {
        readonly scope: string;
        readonly snippets: ReadonlyArray<{ readonly id: string; readonly title: string }>;
        readonly totalMatches: number;
      };
      assert.strictEqual(searchResult.scope, scope);
      assert.isAbove(searchResult.totalMatches, 0);
      const hit = searchResult.snippets[0];
      assert.isDefined(hit);
      // The title an agent sees is the engine's citation, so a quote is
      // attributable without a second round trip.
      assert.include(hit.title, '"Roadmap sync" (meeting, 2026-08-20)');

      const got = yield* callTool("context_get", { id: hit.id });
      assert.isFalse(got.isError);
      const source_ = got.structuredContent as { readonly text: string; readonly title: string };
      assert.strictEqual(source_.title, "Roadmap sync");
      assert.include(source_.text, "cutting the desktop rebrand");
    }),
  );

  it.effect("context_remember writes memory that is searchable straight away", () =>
    Effect.gen(function* () {
      yield* seedThreadProjection;
      const remembered = yield* callTool("context_remember", {
        text: "Ivan prefers Conventional Commits with a scope.",
        scope,
      });
      assert.isFalse(remembered.isError);
      const receipt = remembered.structuredContent as {
        readonly sourceId: string;
        readonly status: string;
      };
      assert.strictEqual(receipt.status, "remembered");
      assert.isAbove(receipt.sourceId.length, 0);

      // No approval step stands between remembering and retrieving.
      const searched = yield* callTool("context_search", {
        query: "Conventional Commits",
        scope,
      });
      const snippets = (
        searched.structuredContent as {
          readonly snippets: ReadonlyArray<{ readonly text: string }>;
        }
      ).snippets;
      assert.isTrue(snippets.some((snippet) => snippet.text.includes("Conventional Commits")));
    }),
  );

  it.effect("a scope-less thread is refused rather than granted a global read", () =>
    Effect.gen(function* () {
      // No `projection_threads` row for this thread and no explicit scope:
      // fail closed instead of searching everything.
      const searched = yield* callTool(
        "context_search",
        { query: "anything" },
        unprojectedInvocation,
      );
      assert.isTrue(searched.isError);
      assert.include(resultText(searched), "No context scope is resolvable for this session");
    }),
  );

  it.effect("a thread in one project may not name another project's scope", () =>
    Effect.gen(function* () {
      yield* seedThreadProjection;
      const searched = yield* callTool("context_search", {
        query: "desktop rebrand",
        scope: "project:proj-beta",
      });
      assert.isTrue(searched.isError);
      assert.include(resultText(searched), "not allowed to use context scope project:proj-beta");
    }),
  );

  /**
   * The escalation the "scope-less thread" test above does not cover: the same
   * unprojected session naming a project explicitly. Resolving no scope of its
   * own must not read as "this session owns every scope" — a thread with no
   * project has nothing to authorize an explicit scope against, so it is
   * refused exactly like the implicit case.
   */
  it.effect("a thread with no project may not name a project scope explicitly", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* ingest.ingestSource(source);
      yield* worker.awaitIdle;

      for (const tool of ["context_search", "context_get", "context_decisions"] as const) {
        const args =
          tool === "context_search"
            ? { query: "desktop rebrand", scope }
            : tool === "context_get"
              ? { id: "mcp-1" }
              : { project: scope };
        const called = yield* callTool(tool, args, unprojectedInvocation);
        assert.isTrue(called.isError, `${tool} leaked to an unprojected thread`);
      }

      const remembered = yield* callTool(
        "context_remember",
        { text: "Injected memory for someone else's project.", scope },
        unprojectedInvocation,
      );
      assert.isTrue(remembered.isError);
    }),
  );

  /**
   * Budget enforcement end to end: the largest request the tool schema admits
   * (budget_tokens at the 100k schema ceiling, detailed format, a query that
   * matches every indexed token) still comes back inside the server cap, so no
   * argument combination turns `context_search` into a transcript dump.
   */
  it.effect("no argument combination lifts context_search past the server budget cap", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      // One source with a single very large segment: the pathological shape
      // for a budget bug is one giant chunk plus a query that matches it.
      yield* ingest.ingestSource({
        kind: "meeting",
        externalId: "mcp-budget",
        title: "Budget stress",
        occurredAt: "2026-08-21T09:00:00.000Z",
        scopes: [projectAlpha],
        segments: [
          { text: `${"the rebrand release desktop budget ".repeat(4_000)}`, speaker: "Ivan" },
        ],
      });
      yield* worker.awaitIdle;

      const searched = yield* callTool("context_search", {
        query: "the rebrand release desktop budget",
        scope,
        budget_tokens: 100_000,
        response_format: "detailed",
      });
      assert.isFalse(searched.isError);
      const result = searched.structuredContent as {
        readonly budgetTokens: number;
        readonly snippets: ReadonlyArray<{ readonly text: string; readonly title: string }>;
      };
      assert.strictEqual(result.budgetTokens, CONTEXT_SEARCH_MAX_BUDGET_TOKENS);
      const spent = result.snippets.reduce(
        (total, snippet) =>
          total + estimateTokenCount(snippet.text) + estimateTokenCount(snippet.title),
        0,
      );
      assert.isAtMost(spent, CONTEXT_SEARCH_MAX_BUDGET_TOKENS);
      // And the ~140k-character transcript never comes back whole: the whole
      // serialized response stays an order of magnitude below the source.
      assert.isBelow(resultText(searched).length, 40_000);
    }),
  );

  /**
   * `context_get` is the other read path; its cap is a character cap, and
   * `expand` is the only lever an agent has on it.
   */
  it.effect("context_get stays inside the expanded cap for a huge source", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      const ingested = yield* ingest.ingestSource({
        kind: "meeting",
        externalId: "mcp-huge",
        title: "Huge source",
        occurredAt: "2026-08-22T09:00:00.000Z",
        scopes: [projectAlpha],
        segments: [{ text: `${"quarterly forecast narrative ".repeat(8_000)}`, speaker: "Ivan" }],
      });
      yield* worker.awaitIdle;

      const got = yield* callTool("context_get", { id: ingested.sourceId, expand: true });
      assert.isFalse(got.isError);
      const fetched = got.structuredContent as {
        readonly text: string;
        readonly truncated: boolean;
      };
      assert.isAtMost(fetched.text.length, CONTEXT_GET_EXPANDED_MAX_CHARS);
      assert.isTrue(fetched.truncated);
    }),
  );

  /**
   * Injection through the query string: FTS5 syntax and SQL metacharacters are
   * data, not grammar. A query engineered to break out of the MATCH expression
   * or the scope predicate must return nothing rather than another project's
   * rows (and must not error, which would signal a parser reached them).
   */
  it.effect("query text cannot break out of the FTS expression or the scope filter", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      yield* ingest.ingestSource({
        kind: "meeting",
        externalId: "mcp-beta-secret",
        title: "Beta only",
        occurredAt: "2026-08-23T09:00:00.000Z",
        scopes: [{ kind: "project", value: "proj-beta" }],
        segments: [{ text: "Beta project codeword pomegranate.", speaker: "Ivan" }],
      });
      yield* worker.awaitIdle;

      const injections = [
        'pomegranate" OR "a" OR "',
        "pomegranate') OR 1=1 --",
        "pomegranate* OR NEAR(sc 10)",
        "'; DROP TABLE nomior_sources; --",
        "%",
        "*",
      ];
      for (const query of injections) {
        const searched = yield* callTool("context_search", { query, scope });
        assert.isFalse(searched.isError, `query ${query} errored instead of returning nothing`);
        const snippets = (
          searched.structuredContent as {
            readonly snippets: ReadonlyArray<{ readonly text: string }>;
          }
        ).snippets;
        for (const snippet of snippets) {
          assert.notInclude(snippet.text, "pomegranate");
        }
      }

      // The table is still there, so nothing executed as SQL.
      const stillThere = yield* callTool("context_search", { query: "desktop rebrand", scope });
      assert.isFalse(stillThere.isError);
    }),
  );

  /**
   * A source attached to two scopes is reachable from each of them and from
   * neither of the others. This is the shared-source case the scope predicate
   * has to get right: `EXISTS` over `nomior_source_scopes` must not let a
   * second scope row widen the first scope's results.
   */
  it.effect("a source in two scopes stays invisible to a third", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      yield* ingest.ingestSource({
        kind: "meeting",
        externalId: "mcp-shared",
        title: "Shared source",
        occurredAt: "2026-08-24T09:00:00.000Z",
        scopes: [projectAlpha, { kind: "customer", value: "acme" }],
        segments: [{ text: "Shared codeword persimmon across two scopes.", speaker: "Ivan" }],
      });
      yield* worker.awaitIdle;

      const inAlpha = yield* callTool("context_search", { query: "persimmon", scope });
      assert.isFalse(inAlpha.isError);
      assert.include(resultText(inAlpha), "persimmon");

      // proj-gamma shares nothing with it, and the thread cannot name it anyway.
      const gammaDenied = yield* callTool("context_search", {
        query: "persimmon",
        scope: "project:proj-gamma",
      });
      assert.isTrue(gammaDenied.isError);
    }),
  );

  /**
   * The deliberate carve-out, pinned so it stays deliberate: a non-project
   * scope (customer, capsule) crosses projects by design, because a customer
   * capsule is what makes cross-project work possible in a single-user
   * product. It is still not a wildcard — a thread must name the scope, the
   * scope must exist on the source, and a thread with no project of its own
   * gets nothing at all. If Nomior ever becomes multi-tenant, this test is the
   * one to change first.
   */
  it.effect("customer scope crosses projects on purpose, and only for a projected thread", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      const worker = yield* EmbeddingWorker;
      yield* seedThreadProjection;
      yield* ingest.ingestSource({
        kind: "meeting",
        externalId: "mcp-customer",
        title: "Customer capsule",
        occurredAt: "2026-08-25T09:00:00.000Z",
        // Attached to a project the calling thread does NOT belong to.
        scopes: [
          { kind: "project", value: "proj-beta" },
          { kind: "customer", value: "acme" },
        ],
        segments: [{ text: "Acme renewal codeword quince.", speaker: "Ivan" }],
      });
      yield* worker.awaitIdle;

      // Named through the shared customer scope: allowed, by design.
      const viaCustomer = yield* callTool("context_search", {
        query: "quince",
        scope: "customer:acme",
      });
      assert.isFalse(viaCustomer.isError);
      assert.include(resultText(viaCustomer), "quince");

      // Named through the owning project: denied, as before.
      const viaProject = yield* callTool("context_search", {
        query: "quince",
        scope: "project:proj-beta",
      });
      assert.isTrue(viaProject.isError);

      // And the carve-out does not extend to a thread with no project.
      const viaUnprojected = yield* callTool(
        "context_search",
        { query: "quince", scope: "customer:acme" },
        unprojectedInvocation,
      );
      assert.isTrue(viaUnprojected.isError);
    }),
  );
});
