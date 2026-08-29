/**
 * Nomior context toolkit - handlers. All broker policy that must not depend on
 * the storage backend is enforced here, in front of the RetrievalPort: the
 * token budget cap, fail-closed scope resolution with per-thread authorization
 * of explicit scopes, secret redaction on every returned string and on
 * remembered text before it is stored, and truncation guidance that steers
 * agents to narrower queries instead of larger reads.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/unstable/ai";

import { NomiorContextLive } from "../../../nomior/NomiorRuntime.ts";
import * as RetrievalPort from "../../../nomior/context/RetrievalPort.ts";
import { redactSecrets } from "../../../nomior/context/redactSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { NomiorContextToolkit } from "./tools.ts";

export const CONTEXT_SEARCH_DEFAULT_BUDGET_TOKENS = 1_600;
export const CONTEXT_SEARCH_MIN_BUDGET_TOKENS = 200;
export const CONTEXT_SEARCH_MAX_BUDGET_TOKENS = 4_000;
export const CONTEXT_SEARCH_CANDIDATE_LIMIT = 50;
export const CONTEXT_GET_MAX_CHARS = 8_000;
export const CONTEXT_GET_EXPANDED_MAX_CHARS = 32_000;
const CONCISE_SNIPPET_MAX_CHARS = 280;
const DETAILED_SNIPPET_MAX_CHARS = 700;
/** Titles are budget-charged, so they must be bounded like snippet text. */
const SNIPPET_TITLE_MAX_CHARS = 160;
/** Ids, dates, spans, and scores cost tokens too; charged per snippet. */
const SNIPPET_OVERHEAD_TOKENS = 24;

/**
 * Rough token heuristic; the cap is a guardrail, not an invoice. Weighted per
 * character because PLAN.md's corpus is EN/RU/UK: ASCII ≈ 4 chars/token,
 * non-ASCII (Cyrillic included) ≈ 2 chars/token, so a flat chars/4 would
 * undercount Russian/Ukrainian text roughly 2x.
 */
export const estimateTokenCount = (text: string): number => {
  let weight = 0;
  for (let index = 0; index < text.length; index++) {
    weight += text.charCodeAt(index) < 128 ? 1 : 2;
  }
  return Math.ceil(weight / 4);
};

/** Longest prefix of `text` whose {@link estimateTokenCount} stays within `maxTokens`. */
const truncateToTokenBudget = (text: string, maxTokens: number): string => {
  if (estimateTokenCount(text) <= maxTokens) return text;
  const maxWeight = maxTokens * 4 - 2; // reserve the appended ellipsis
  let weight = 0;
  for (let index = 0; index < text.length; index++) {
    weight += text.charCodeAt(index) < 128 ? 1 : 2;
    if (weight > maxWeight) return `${text.slice(0, index)}…`;
  }
  return text;
};

/**
 * Clamp a requested budget into the server's range. NaN is treated as "not
 * requested" rather than clamped, because it survives `Math.min`/`Math.max`
 * and a NaN budget makes every `spent + cost > budget` test false — an
 * unbounded read. (±Infinity clamps normally to the cap and the floor.) The
 * tool schema rejects both first; this keeps the guarantee from resting on
 * that alone.
 */
export const clampBudgetTokens = (requested: number | undefined): number => {
  const wanted =
    requested === undefined || Number.isNaN(requested)
      ? CONTEXT_SEARCH_DEFAULT_BUDGET_TOKENS
      : requested;
  return Math.min(
    CONTEXT_SEARCH_MAX_BUDGET_TOKENS,
    Math.max(CONTEXT_SEARCH_MIN_BUDGET_TOKENS, wanted),
  );
};

/**
 * Fail-closed scope resolution: an explicit `scope` argument is authorized
 * against the calling thread via the port (so an adapter can deny cross-scope
 * access), otherwise the thread's configured project scope is used; with
 * neither, the call is refused.
 */
const resolveScope = Effect.fn("NomiorContextToolkit.resolveScope")(function* (
  explicitScope: RetrievalPort.ContextScope | undefined,
): Effect.fn.Return<
  RetrievalPort.ContextScope,
  | RetrievalPort.ContextScopeRequiredError
  | RetrievalPort.ContextScopeDeniedError
  | RetrievalPort.ContextUnavailableError,
  McpInvocationContext.McpInvocationContext | RetrievalPort.ContextRetrievalPort
> {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const port = yield* RetrievalPort.ContextRetrievalPort;
  if (explicitScope !== undefined) {
    yield* port.authorizeScope({ threadId: invocation.threadId, scope: explicitScope });
    return explicitScope;
  }
  const defaultScope = yield* port.defaultScopeForThread(invocation.threadId);
  if (Option.isNone(defaultScope)) {
    return yield* new RetrievalPort.ContextScopeRequiredError({
      threadId: invocation.threadId,
    });
  }
  return defaultScope.value;
});

const truncateText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;

const redactSnippet = (
  snippet: RetrievalPort.ContextSnippet,
  maxChars: number,
): RetrievalPort.ContextSnippet => ({
  ...snippet,
  title: truncateText(redactSecrets(snippet.title), SNIPPET_TITLE_MAX_CHARS),
  text: truncateText(redactSecrets(snippet.text), maxChars),
});

const searchGuidance = (budgetTokens: number): string =>
  `Results were trimmed to fit budget_tokens=${budgetTokens}. Narrow the query or scope, add a date, or fetch one id with context_get instead of raising the budget.`;

const contextSearch = Effect.fn("NomiorContextToolkit.contextSearch")(function* (input: {
  readonly query: string;
  readonly scope?: RetrievalPort.ContextScope | undefined;
  readonly budget_tokens?: number | undefined;
  readonly response_format?: "concise" | "detailed" | undefined;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  const scope = yield* resolveScope(input.scope);
  const budgetTokens = clampBudgetTokens(input.budget_tokens);
  const responseFormat = input.response_format ?? "concise";
  const snippetMaxChars =
    responseFormat === "detailed" ? DETAILED_SNIPPET_MAX_CHARS : CONCISE_SNIPPET_MAX_CHARS;

  const response = yield* port.search({
    query: input.query,
    scope,
    limit: CONTEXT_SEARCH_CANDIDATE_LIMIT,
    responseFormat,
  });

  const kept: Array<RetrievalPort.ContextSnippet> = [];
  let spentTokens = 0;
  let budgetClippedTopHit = false;
  for (const candidate of response.snippets) {
    const snippet = redactSnippet(candidate, snippetMaxChars);
    const cost =
      SNIPPET_OVERHEAD_TOKENS +
      estimateTokenCount(snippet.text) +
      estimateTokenCount(snippet.title);
    if (spentTokens + cost > budgetTokens) {
      if (kept.length > 0) break;
      // Never return an empty result solely because of the budget: the top
      // hit is trimmed until it fits, and the result is reported as truncated
      // even when it was the only match.
      const textBudgetTokens = Math.max(
        20,
        budgetTokens - SNIPPET_OVERHEAD_TOKENS - estimateTokenCount(snippet.title),
      );
      const trimmed = { ...snippet, text: truncateToTokenBudget(snippet.text, textBudgetTokens) };
      kept.push(trimmed);
      spentTokens = budgetTokens;
      budgetClippedTopHit = true;
      break;
    }
    spentTokens += cost;
    kept.push(snippet);
  }

  const truncated = budgetClippedTopHit || kept.length < response.totalMatches;
  return {
    scope,
    snippets: kept,
    totalMatches: response.totalMatches,
    budgetTokens,
    truncated,
    ...(truncated ? { guidance: searchGuidance(budgetTokens) } : {}),
  };
});

const contextGet = Effect.fn("NomiorContextToolkit.contextGet")(function* (input: {
  readonly id: string;
  readonly expand?: boolean | undefined;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  // context_get carries no scope argument by design (ids come from a scoped
  // search), so the thread's own scope is the boundary and a scope-less
  // session is refused rather than granted global reads.
  const scope = yield* resolveScope(undefined);
  const source = yield* port.get({ id: input.id, scope });
  const maxChars = input.expand === true ? CONTEXT_GET_EXPANDED_MAX_CHARS : CONTEXT_GET_MAX_CHARS;
  const text = redactSecrets(source.text);
  const truncated = text.length > maxChars;
  return {
    id: source.id,
    sourceKind: source.sourceKind,
    title: redactSecrets(source.title),
    text: truncateText(text, maxChars),
    ...(source.date === undefined ? {} : { date: source.date }),
    truncated,
    ...(truncated
      ? {
          guidance:
            input.expand === true
              ? "The source exceeds the expanded cap. Use context_search with narrower terms to target the passage you need."
              : "Excerpt capped; pass expand=true for a larger window, or search for the specific passage.",
        }
      : {}),
  };
});

const contextDecisions = Effect.fn("NomiorContextToolkit.contextDecisions")(function* (input: {
  readonly project: RetrievalPort.ContextScope;
  readonly since?: string | undefined;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  const project = yield* resolveScope(input.project);
  const decisions = yield* port.decisions({
    project,
    ...(input.since === undefined ? {} : { since: input.since }),
  });
  return {
    project,
    decisions: decisions.map((decision) => ({
      ...decision,
      statement: redactSecrets(decision.statement),
    })),
  };
});

const contextRemember = Effect.fn("NomiorContextToolkit.contextRemember")(function* (input: {
  readonly text: string;
  readonly scope: RetrievalPort.ContextScope;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  const scope = yield* resolveScope(input.scope);
  // Scrubbed on the way in as well as on the way out: a pasted secret must
  // never reach the broker waiting on the return-path redaction.
  const receipt = yield* port.remember({ text: redactSecrets(input.text), scope });
  return {
    sourceId: receipt.sourceId,
    status: receipt.created ? ("remembered" as const) : ("already-known" as const),
  };
});

const handlers = {
  context_search: contextSearch,
  context_get: contextGet,
  context_decisions: contextDecisions,
  context_remember: contextRemember,
} satisfies Parameters<typeof NomiorContextToolkit.toLayer>[0];

export const NomiorContextToolkitHandlersLive = NomiorContextToolkit.toLayer(handlers);

/**
 * Registration layer merged into `McpHttpServer.layer`, wired to the real
 * context engine: `NomiorRuntime.NomiorContextLive` builds the broker (FTS +
 * vectors + embedding worker), the memory-candidate store and the retrieval
 * port adapter. The only remaining requirement is `SqlClient`, which the
 * server's route layer already provides.
 *
 * `RetrievalPort.layerUnavailable` stays exported for a build that wants the
 * tools present but failing closed; it is no longer what ships.
 */
export const NomiorContextToolkitRegistrationLive = McpServer.toolkit(NomiorContextToolkit).pipe(
  Layer.provide(NomiorContextToolkitHandlersLive),
  Layer.provide(NomiorContextLive),
);
