/**
 * RetrievalPort - the narrow interface the Nomior MCP context toolkit depends
 * on for retrieval. The real context engine (FTS + vectors + rerank under
 * `apps/server/src/nomior/context/`) satisfies it through
 * `RetrievalPortLive.ts`, which is what the shipped toolkit is wired to.
 *
 * The two other layers here are not production paths: `layerInMemory` backs
 * the toolkit's handler tests with a deterministic term-overlap ranker, and
 * `layerUnavailable` fails every tool closed — for a build that wants the
 * tools advertised without a context store behind them.
 *
 * @module nomior/context/RetrievalPort
 */
import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Opaque scope identifier (a Nomior capsule/project id, e.g. `project:nomior`). */
export const ContextScope = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ContextScope = typeof ContextScope.Type;

/** Citable identifier for a source or chunk; resolvable via `context_get`. */
export const ContextId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ContextId = typeof ContextId.Type;

export const ContextSourceKind = Schema.Literals([
  "meeting",
  "decision",
  "memory",
  "document",
  "mail",
  "event",
]);
export type ContextSourceKind = typeof ContextSourceKind.Type;

/** Character offsets into the full source text; evidence for a snippet. */
export const ContextEvidenceSpan = Schema.Struct({
  start: NonNegativeInt.annotate({ description: "Start character offset in the source text." }),
  end: NonNegativeInt.annotate({ description: "End character offset in the source text." }),
});
export type ContextEvidenceSpan = typeof ContextEvidenceSpan.Type;

export const ContextSnippet = Schema.Struct({
  id: ContextId.annotate({ description: "Citable id; pass to context_get for full fidelity." }),
  sourceKind: ContextSourceKind,
  title: Schema.String,
  text: Schema.String.annotate({ description: "Extracted snippet, budget-bounded." }),
  score: Schema.Number.annotate({ description: "Relevance in [0, 1]." }),
  date: Schema.optional(
    Schema.String.annotate({ description: "ISO-8601 date of the source, when known." }),
  ),
  span: Schema.optional(ContextEvidenceSpan),
});
export type ContextSnippet = typeof ContextSnippet.Type;

export const ContextDecision = Schema.Struct({
  id: ContextId,
  kind: Schema.Literals(["decision", "task"]),
  statement: Schema.String,
  decidedAt: Schema.String.annotate({ description: "ISO-8601 date the item was recorded." }),
  status: Schema.optional(Schema.Literals(["open", "done", "superseded"])),
  evidence: Schema.Array(
    Schema.Struct({
      sourceId: ContextId,
      span: Schema.optional(ContextEvidenceSpan),
    }),
  ),
});
export type ContextDecision = typeof ContextDecision.Type;

export class ContextUnavailableError extends Schema.TaggedErrorClass<ContextUnavailableError>()(
  "ContextUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The Nomior context engine is unavailable: ${this.reason}`;
  }
}

export class ContextScopeRequiredError extends Schema.TaggedErrorClass<ContextScopeRequiredError>()(
  "ContextScopeRequiredError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return (
      "No context scope is resolvable for this session. " +
      "Pass an explicit `scope` (a Nomior project id) to context_search, or ask the user which project this thread belongs to."
    );
  }
}

export class ContextSourceNotFoundError extends Schema.TaggedErrorClass<ContextSourceNotFoundError>()(
  "ContextSourceNotFoundError",
  {
    id: Schema.String,
  },
) {
  override get message(): string {
    return `No context source with id ${this.id} is visible in this scope. Use ids returned by context_search.`;
  }
}

export class ContextScopeDeniedError extends Schema.TaggedErrorClass<ContextScopeDeniedError>()(
  "ContextScopeDeniedError",
  {
    threadId: Schema.String,
    scope: Schema.String,
  },
) {
  override get message(): string {
    return `This session is not allowed to use context scope ${this.scope}. Use the thread's own project scope, or ask the user which project this thread belongs to.`;
  }
}

export const ContextToolError = Schema.Union([
  ContextUnavailableError,
  ContextScopeRequiredError,
  ContextScopeDeniedError,
  ContextSourceNotFoundError,
]);
export type ContextToolError = typeof ContextToolError.Type;

/** Full-fidelity source record as the port returns it (server-internal shape). */
export interface ContextSourceRecord {
  readonly id: ContextId;
  readonly scope: ContextScope;
  readonly sourceKind: ContextSourceKind;
  readonly title: string;
  readonly text: string;
  readonly date?: string;
}

export interface ContextSearchRequest {
  readonly query: string;
  readonly scope: ContextScope;
  /** Maximum candidates the port should rank and return; the toolkit trims further to the token budget. */
  readonly limit: number;
  readonly responseFormat: "concise" | "detailed";
}

export interface ContextSearchResponse {
  readonly snippets: ReadonlyArray<ContextSnippet>;
  readonly totalMatches: number;
}

export interface ContextGetRequest {
  readonly id: string;
  /** Scope the caller is confined to; sources outside it must resolve as not found. */
  readonly scope: ContextScope;
}

export interface ContextDecisionsRequest {
  readonly project: ContextScope;
  /** ISO-8601 date; when present, only items decided on or after it. */
  readonly since?: string;
}

export interface ContextRememberRequest {
  readonly text: string;
  readonly scope: ContextScope;
}

export interface ContextScopeAuthorizationRequest {
  readonly threadId: string;
  readonly scope: ContextScope;
}

export interface ContextRememberReceipt {
  /** The `memory` source the text became; it is retrievable immediately. */
  readonly sourceId: string;
  /** False when the same fact was already remembered for this scope. */
  readonly created: boolean;
}

export interface ContextRetrievalPortShape {
  readonly search: (
    request: ContextSearchRequest,
  ) => Effect.Effect<ContextSearchResponse, ContextUnavailableError>;
  readonly get: (
    request: ContextGetRequest,
  ) => Effect.Effect<ContextSourceRecord, ContextUnavailableError | ContextSourceNotFoundError>;
  readonly decisions: (
    request: ContextDecisionsRequest,
  ) => Effect.Effect<ReadonlyArray<ContextDecision>, ContextUnavailableError>;
  /** Records a memory candidate. Never promotes: promotion is a separate, user-approved step. */
  readonly remember: (
    request: ContextRememberRequest,
  ) => Effect.Effect<ContextRememberReceipt, ContextUnavailableError>;
  /** The scope bound to a thread (its capsule/project), when one is configured. */
  readonly defaultScopeForThread: (threadId: string) => Effect.Effect<Option.Option<ContextScope>>;
  /**
   * Gate for every caller-supplied scope. The toolkit calls this whenever an
   * agent names a scope explicitly (search, decisions, remember); a thread's
   * own default scope is authorized by construction and never passes through
   * here.
   *
   * Must fail closed: an adapter that cannot establish what the thread is
   * allowed to see denies, rather than treating "no answer" as "everything".
   * `RetrievalPortLive` refuses any explicit scope from a thread with no
   * project, and any other project's scope from a thread that has one;
   * customer and capsule scopes stay open for a thread that has a project,
   * because a shared capsule crossing projects is the point of one.
   */
  readonly authorizeScope: (
    request: ContextScopeAuthorizationRequest,
  ) => Effect.Effect<void, ContextUnavailableError | ContextScopeDeniedError>;
}

export class ContextRetrievalPort extends Context.Service<
  ContextRetrievalPort,
  ContextRetrievalPortShape
>()("t3/nomior/context/RetrievalPort/ContextRetrievalPort") {}

const UNAVAILABLE_REASON =
  "the context engine is not wired into this build; retrieval is disabled until it is.";

/**
 * Fail-closed default so `McpHttpServer.layer` stays self-contained before the
 * real engine lands. The integrator replaces this with the ContextRetrieval
 * adapter layer at the single provide site in
 * `mcp/toolkits/nomior/handlers.ts`.
 */
export const layerUnavailable: Layer.Layer<ContextRetrievalPort> = Layer.succeed(
  ContextRetrievalPort,
  ContextRetrievalPort.of({
    search: () => Effect.fail(new ContextUnavailableError({ reason: UNAVAILABLE_REASON })),
    get: () => Effect.fail(new ContextUnavailableError({ reason: UNAVAILABLE_REASON })),
    decisions: () => Effect.fail(new ContextUnavailableError({ reason: UNAVAILABLE_REASON })),
    remember: () => Effect.fail(new ContextUnavailableError({ reason: UNAVAILABLE_REASON })),
    defaultScopeForThread: () => Effect.succeed(Option.none()),
    authorizeScope: () => Effect.fail(new ContextUnavailableError({ reason: UNAVAILABLE_REASON })),
  }),
);

export interface InMemoryContextSeed {
  readonly sources?: ReadonlyArray<ContextSourceRecord>;
  readonly decisions?: ReadonlyArray<ContextDecision & { readonly project: ContextScope }>;
  readonly threadScopes?: Readonly<Record<string, ContextScope>>;
  /**
   * Explicit-scope grants per thread. A thread absent from this map may use
   * any scope (the single-user trust default documented on `authorizeScope`);
   * a listed thread may use only its default scope plus the scopes granted
   * here.
   */
  readonly threadScopeGrants?: Readonly<Record<string, ReadonlyArray<ContextScope>>>;
}

const tokenizeQuery = (query: string): ReadonlyArray<string> =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);

const SNIPPET_WINDOW_CHARS = 320;

const extractSnippet = (
  source: ContextSourceRecord,
  terms: ReadonlyArray<string>,
): { readonly text: string; readonly span: ContextEvidenceSpan } => {
  const lowered = source.text.toLowerCase();
  const firstHit = terms
    .map((term) => lowered.indexOf(term))
    .filter((index) => index >= 0)
    .reduce((best, index) => Math.min(best, index), Number.POSITIVE_INFINITY);
  const anchor = Number.isFinite(firstHit) ? firstHit : 0;
  const start = Math.max(0, anchor - Math.floor(SNIPPET_WINDOW_CHARS / 4));
  const end = Math.min(source.text.length, start + SNIPPET_WINDOW_CHARS);
  return {
    text: source.text.slice(start, end),
    span: { start, end },
  };
};

const scoreSource = (source: ContextSourceRecord, terms: ReadonlyArray<string>): number => {
  if (terms.length === 0) return 0;
  const text = source.text.toLowerCase();
  const title = source.title.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (title.includes(term)) hits += 2;
    else if (text.includes(term)) hits += 1;
  }
  return Math.min(1, hits / (terms.length * 2));
};

/**
 * Deterministic in-memory implementation for tests and local development.
 * Ranking is plain term overlap - fidelity to the real engine's contract
 * (scoped, ranked, evidence-bearing snippets), not to its quality.
 */
export const layerInMemory = (seed: InMemoryContextSeed = {}): Layer.Layer<ContextRetrievalPort> =>
  Layer.sync(ContextRetrievalPort, () => {
    const sources = seed.sources ?? [];
    const seededDecisions = seed.decisions ?? [];
    const threadScopes = seed.threadScopes ?? {};
    const threadScopeGrants = seed.threadScopeGrants ?? {};
    let memorySequence = 0;
    const remembered: Array<ContextRememberRequest & { readonly sourceId: string }> = [];

    return ContextRetrievalPort.of({
      search: (request) =>
        Effect.sync(() => {
          const terms = tokenizeQuery(request.query);
          const matches = sources
            .filter((source) => source.scope === request.scope)
            .map((source) => ({ source, score: scoreSource(source, terms) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score);
          const snippets = matches.slice(0, request.limit).map(({ source, score }) => {
            const { text, span } = extractSnippet(source, terms);
            return {
              id: source.id,
              sourceKind: source.sourceKind,
              title: source.title,
              text,
              score,
              ...(source.date === undefined ? {} : { date: source.date }),
              span,
            } satisfies ContextSnippet;
          });
          return { snippets, totalMatches: matches.length };
        }),
      get: Effect.fnUntraced(function* (request) {
        const source = sources.find((candidate) => candidate.id === request.id);
        // A source outside the caller's scope reads as not found so ids never
        // leak existence across scopes.
        if (!source || source.scope !== request.scope) {
          return yield* new ContextSourceNotFoundError({ id: request.id });
        }
        return source;
      }),
      decisions: (request) =>
        Effect.sync(() => {
          // An unparseable `since` (NaN) matches nothing: fail closed like the
          // rest of the port. The toolkit schema rejects invalid dates before
          // they reach here; this only covers direct internal callers.
          const sinceMs = request.since === undefined ? undefined : Date.parse(request.since);
          return seededDecisions
            .filter((decision) => decision.project === request.project)
            .filter(
              (decision) => sinceMs === undefined || Date.parse(decision.decidedAt) >= sinceMs,
            )
            .map(({ project: _project, ...decision }) => decision);
        }),
      remember: (request) =>
        Effect.sync(() => {
          const seen = remembered.find(
            (entry) => entry.text === request.text && entry.scope === request.scope,
          );
          if (seen !== undefined) return { sourceId: seen.sourceId, created: false };
          memorySequence += 1;
          const sourceId = `mem_${memorySequence}`;
          remembered.push({ ...request, sourceId });
          return { sourceId, created: true };
        }),
      defaultScopeForThread: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threadScopes[threadId])),
      authorizeScope: Effect.fnUntraced(function* (request) {
        const grants = threadScopeGrants[request.threadId];
        if (
          grants === undefined ||
          request.scope === threadScopes[request.threadId] ||
          grants.includes(request.scope)
        ) {
          return;
        }
        return yield* new ContextScopeDeniedError({
          threadId: request.threadId,
          scope: request.scope,
        });
      }),
    });
  });
