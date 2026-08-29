/**
 * Seam test for the fork's one upstream touch in `McpHttpServer.ts`: it builds
 * the exported `McpHttpServer.layer` itself - not a locally recomposed layer -
 * so if an upstream sync reverts or moves the `Layer.mergeAll` that registers
 * the Nomior context toolkit beside the preview toolkit, this file fails by
 * name instead of the app silently losing the context tools.
 *
 * It also proves the toolkit's port is actually PROVIDED, not merely declared:
 * a toolkit registered without `ContextRetrievalPort` builds fine and only
 * fails when a tool is called, so the tool calls below go through the real
 * broker on an in-memory database. `nomior/integration/McpContextToolkit.test.ts`
 * carries the round-trip (ingest -> context_search -> context_get); this file
 * stays about registration.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-nomior-test"),
  threadId: ThreadId.make("thread-nomior-test"),
  providerSessionId: "provider-session-nomior-test",
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
    clientInfo: { name: "nomior-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

// The auth middleware's registry is stubbed: it guards the HTTP transport,
// which this file never exercises (upstream's `McpHttpServer.test.ts` covers
// it), and the real one drags in Crypto/HttpServer/ServerEnvironment.
const McpSessionRegistryStub = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("unused in the registration seam test"),
    resolve: () => Effect.sync(() => undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

// The application's own MCP layer, with only its environment supplied. The
// router is never served: registration is what is under test here. SqlClient
// is real (in-memory sqlite with the Nomior migrations) because the toolkit's
// retrieval port is now the real context engine.
const AppLayer = McpHttpServer.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      HttpRouter.layer,
      McpSessionRegistryStub,
      PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
  // Merged, not just provided: the scope-authorization path reads the thread
  // projection, so the tests below need to seed the row a real session has.
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

/** The `projection_threads` row every thread created in the normal UI has. */
const seedThreadProjection = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    INSERT OR IGNORE INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
    VALUES (${invocation.threadId}, 'nomior', 'Seam', ${"2026-08-20T09:00:00.000Z"}, ${"2026-08-20T09:00:00.000Z"})
  `,
);

it.layer(AppLayer)("McpHttpServer Nomior registration seam", (it) => {
  it.effect("the exported app layer registers the four context tools with their annotations", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      for (const name of [
        "context_search",
        "context_get",
        "context_decisions",
        "context_remember",
      ]) {
        expect(names).toContain(name);
      }
      // The merge must add our toolkit without displacing the preview toolkit.
      expect(names).toContain("preview_status");
      expect(names).toContain("preview_snapshot");

      const searchTool = server.tools.find(({ tool }) => tool.name === "context_search");
      expect(searchTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(searchTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(searchTool?.tool.annotations?.openWorldHint).toBe(false);

      const rememberTool = server.tools.find(({ tool }) => tool.name === "context_remember");
      expect(rememberTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(rememberTool?.tool.annotations?.destructiveHint).toBe(false);
    }),
  );

  it.effect("reaches the real retrieval port through the MCP call path", () =>
    Effect.gen(function* () {
      yield* seedThreadProjection;
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "context_search",
          arguments: { query: "anything", scope: "project:nomior" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      // An empty corpus, not an unavailable engine: the port is provided and
      // ran a real query. `layerUnavailable` would have failed the call with
      // "the context engine is unavailable".
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        scope: "project:nomior",
        snippets: [],
        totalMatches: 0,
      });
    }),
  );

  it.effect(
    "rejects an impossible `since` date as invalid params instead of dropping the filter",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const error = yield* server
          .callTool({
            name: "context_decisions",
            arguments: { project: "project:nomior", since: "2026-99-99" },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.flip,
          );
        expect(error._tag).toBe("InvalidParams");
      }),
  );
});
