/**
 * Nomior context toolkit - MCP tool definitions for the context broker.
 * Exactly four tools: one hot search
 * tool plus three drill-down/write tools, every description kept token-cheap
 * because tool schemas ride in the agent's context on every turn.
 *
 * Defer/lazy loading, investigated 2026-08-29: the design asks for
 * `defer_loading: true` on everything but `context_search`, but no such field
 * exists to publish. The MCP spec (2025-06-18) has no defer hint on Tool;
 * effect's McpServer can publish arbitrary `_meta` via the `Tool.Meta`
 * annotation, but no client - Claude Code included - honors a server-published
 * defer hint today (Anthropic's `defer_loading` is client-side `mcp_toolset`
 * configuration, and Claude Code's own tool deferral is client-decided). So we
 * do not invent a field; minimal descriptions are the mitigation.
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as RetrievalPort from "../../../nomior/context/RetrievalPort.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  RetrievalPort.ContextRetrievalPort,
];

// The invocation bearer token already scopes calls to one live provider
// session (McpSessionRegistry). A dedicated "context" entry in the upstream
// McpCapability union would need an upstream edit beyond the registration
// line, so per-capability gating is deferred to the integrator; scope
// enforcement below is the effective boundary.

// Parameter schemas stay transform-free (`Schema.String`, not the trimmed
// ContextScope/ContextId codecs): `Tool.getJsonSchema` renders the encoded
// side, where a transform's annotations are dropped and the description with
// them. Optional fields annotate both the inner schema and the wrapper, like
// upstream's `PreviewAutomationTabTargetFields`.
const SCOPE_DESCRIPTION = "Nomior project scope id. Omit to use this thread's project.";
const ScopeParameter = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

const ContextSearchParameters = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)).annotate({
    description: "Natural-language search query.",
  }),
  scope: Schema.optional(ScopeParameter.annotate({ description: SCOPE_DESCRIPTION })).annotate({
    description: SCOPE_DESCRIPTION,
  }),
  budget_tokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })).annotate({
      description: "Token budget for the result (default 1600, server-capped at 4000).",
    }),
  ).annotate({ description: "Token budget for the result (default 1600, server-capped at 4000)." }),
  response_format: Schema.optional(
    Schema.Literals(["concise", "detailed"]).annotate({
      description: "concise (default) = short snippets; detailed = longer excerpts.",
    }),
  ).annotate({ description: "concise (default) = short snippets; detailed = longer excerpts." }),
});

export const ContextSearchResult = Schema.Struct({
  scope: RetrievalPort.ContextScope.annotate({ description: "Scope the search ran in." }),
  snippets: Schema.Array(RetrievalPort.ContextSnippet),
  totalMatches: Schema.Int.annotate({ description: "Matches in scope before budget trimming." }),
  budgetTokens: Schema.Int.annotate({ description: "Effective token budget after clamping." }),
  truncated: Schema.Boolean,
  guidance: Schema.optional(
    Schema.String.annotate({ description: "How to get more signal when results were trimmed." }),
  ),
});
export type ContextSearchResult = typeof ContextSearchResult.Type;

const EXPAND_DESCRIPTION = "true = larger excerpt cap for long sources (still server-bounded).";

const ContextGetParameters = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
    description: "Citable id returned by context_search.",
  }),
  expand: Schema.optional(Schema.Boolean.annotate({ description: EXPAND_DESCRIPTION })).annotate({
    description: EXPAND_DESCRIPTION,
  }),
});

export const ContextGetResult = Schema.Struct({
  id: RetrievalPort.ContextId,
  sourceKind: RetrievalPort.ContextSourceKind,
  title: Schema.String,
  text: Schema.String.annotate({ description: "Full source text, server-capped." }),
  date: Schema.optional(Schema.String.annotate({ description: "ISO-8601 date, when known." })),
  truncated: Schema.Boolean,
  guidance: Schema.optional(
    Schema.String.annotate({ description: "How to reach the elided remainder." }),
  ),
});
export type ContextGetResult = typeof ContextGetResult.Type;

const SINCE_DESCRIPTION = "ISO-8601 date; only items decided on or after it.";

const ContextDecisionsParameters = Schema.Struct({
  project: ScopeParameter.annotate({
    description: "Nomior project scope id to list decisions for.",
  }),
  since: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}/),
      // The pattern alone admits impossible dates ("2026-99-99") that would
      // otherwise reach the port as NaN; reject them here so an invalid
      // `since` is an InvalidParams error, never a silently dropped filter.
      Schema.makeFilter((value: string) =>
        Number.isNaN(Date.parse(value)) ? "must be a real ISO-8601 calendar date" : undefined,
      ),
    ).annotate({
      description: SINCE_DESCRIPTION,
    }),
  ).annotate({ description: SINCE_DESCRIPTION }),
});

export const ContextDecisionsResult = Schema.Struct({
  project: RetrievalPort.ContextScope,
  decisions: Schema.Array(RetrievalPort.ContextDecision),
});
export type ContextDecisionsResult = typeof ContextDecisionsResult.Type;

const ContextRememberParameters = Schema.Struct({
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
    description: "The fact or preference to remember.",
  }),
  scope: ScopeParameter.annotate({
    description: "Nomior project scope id the memory belongs to.",
  }),
});

export const ContextRememberResult = Schema.Struct({
  sourceId: Schema.String.annotate({
    description: "Id of the memory source; it is searchable immediately.",
  }),
  status: Schema.Literals(["remembered", "already-known"]).annotate({
    description: "`already-known` when this fact was already remembered for this scope.",
  }),
});
export type ContextRememberResult = typeof ContextRememberResult.Type;

// openWorldHint=false throughout: the MCP spec's own example of a closed-world
// tool is a memory tool.
const contextReadTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

export const ContextSearchTool = contextReadTool(
  Tool.make("context_search", {
    description:
      "Search Nomior project context (meetings, decisions, memory, documents). Returns ranked snippets with citable ids, evidence spans, and dates. Use before asking the user; cite ids in answers.",
    parameters: ContextSearchParameters,
    success: ContextSearchResult,
    failure: RetrievalPort.ContextToolError,
    dependencies,
  }).annotate(Tool.Title, "Search project context"),
);

export const ContextGetTool = contextReadTool(
  Tool.make("context_get", {
    description:
      "Fetch one source at full fidelity by a citable id from context_search. Only after searching; never guess ids.",
    parameters: ContextGetParameters,
    success: ContextGetResult,
    failure: RetrievalPort.ContextToolError,
    dependencies,
  }).annotate(Tool.Title, "Get context source"),
);

export const ContextDecisionsTool = contextReadTool(
  Tool.make("context_decisions", {
    description:
      "List structured decisions and tasks recorded for a project, newest first, optionally since a date.",
    parameters: ContextDecisionsParameters,
    success: ContextDecisionsResult,
    failure: RetrievalPort.ContextToolError,
    dependencies,
  }).annotate(Tool.Title, "List project decisions"),
);

export const ContextRememberTool = Tool.make("context_remember", {
  description:
    "Propose a memory candidate for a project scope. Never auto-promotes: the user must approve it in Nomior before it becomes memory.",
  parameters: ContextRememberParameters,
  success: ContextRememberResult,
  failure: RetrievalPort.ContextToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose memory candidate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const NomiorContextToolkit = Toolkit.make(
  ContextSearchTool,
  ContextGetTool,
  ContextDecisionsTool,
  ContextRememberTool,
);
