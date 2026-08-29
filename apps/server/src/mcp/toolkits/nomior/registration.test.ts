/**
 * Seam test for the fork's one upstream touch in `McpHttpServer.ts`: it builds
 * the exported `McpHttpServer.layer` itself - not a locally recomposed layer -
 * so if an upstream sync reverts or moves the `Layer.mergeAll` that registers
 * the Nomior context toolkit beside the preview toolkit, this file fails by
 * name instead of the app silently losing the context tools.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";

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
// router is never served: registration is what is under test here.
const AppLayer = McpHttpServer.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      HttpRouter.layer,
      McpSessionRegistryStub,
      PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
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

  it.effect("serves fail-closed tool errors through the MCP call path while unwired", () =>
    Effect.gen(function* () {
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
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("context engine is unavailable"),
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
