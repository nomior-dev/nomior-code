/**
 * RetrievalPortLive — the real context engine behind the MCP context toolkit.
 *
 * This is the adapter `RetrievalPort.ts` documents as the swap for
 * `layerUnavailable`: it satisfies `ContextRetrievalPort` using
 * `ContextRetrieval` (hybrid BM25 + dense search), `ContextIngest` (via the
 * memory-candidate store) and the broker's own tables — no fixtures, no
 * in-memory ranker.
 *
 * Three impedance mismatches the adapter owns, all of them one-way and
 * documented here so neither side has to know about the other:
 *
 * 1. **Scope.** The toolkit speaks flat strings (`"project:nomior"`); the
 *    engine speaks `{ kind, value }`. `parseContextScope` is the only place
 *    that translation happens, and an unprefixed string means a project scope.
 * 2. **Source kinds.** The toolkit's catalog has `mail`/`event`; the engine's
 *    has `email`/`session`. `toPortSourceKind` maps engine → toolkit; the true
 *    connector kind stays in the source's provenance.
 * 3. **Score.** The engine returns raw reciprocal-rank-fusion scores (≈0.016
 *    for a top hit), the toolkit's contract says `[0, 1]`. The adapter scales
 *    by the best score in the result set, so the top hit is 1.0 and the rest
 *    are relative to it — an ordering signal, which is all the toolkit uses it
 *    for.
 *
 * @module nomior/context/RetrievalPortLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ClaudeMemories } from "../memory/ClaudeMemories.ts";
import { MemoryWriter } from "../memory/MemoryWriter.ts";
import { NomiorScopeKind, type NomiorScope, type NomiorSourceKind } from "./Model.ts";
import { ContextRetrieval } from "./Retrieval.ts";
import {
  ContextRetrievalPort,
  ContextUnavailableError,
  ContextScopeDeniedError,
  ContextSourceNotFoundError,
  type ContextDecision,
  type ContextRetrievalPortShape,
  type ContextId,
  type ContextScope,
  type ContextSnippet,
  type ContextSourceKind,
} from "./RetrievalPort.ts";

/**
 * Candidates the engine may return per toolkit search. The toolkit trims to
 * its own token budget afterwards, so the engine's budget is set generously
 * here — double-trimming would drop hits the toolkit could still have fit.
 */
const ENGINE_BUDGET_TOKENS = 60_000;

const SCOPE_KINDS: ReadonlyArray<string> = NomiorScopeKind.literals;

/**
 * `"project:nomior"` → `{ kind: "project", value: "nomior" }`.
 * A string with no recognized `kind:` prefix is a project scope, so an agent
 * that passes a bare project id is understood rather than refused.
 */
export const parseContextScope = (scope: ContextScope): NomiorScope => {
  const separator = scope.indexOf(":");
  if (separator > 0) {
    const kind = scope.slice(0, separator);
    const value = scope.slice(separator + 1);
    if (SCOPE_KINDS.includes(kind) && value.length > 0) {
      return { kind: kind as NomiorScope["kind"], value };
    }
  }
  return { kind: "project", value: scope };
};

export const formatContextScope = (scope: NomiorScope): ContextScope =>
  `${scope.kind}:${scope.value}` as ContextScope;

/**
 * Engine kind → toolkit kind. `session` has no toolkit equivalent and reads as
 * a document; the engine kind stays authoritative in storage.
 */
export const toPortSourceKind = (kind: NomiorSourceKind): ContextSourceKind => {
  switch (kind) {
    case "email":
      return "mail";
    case "session":
      return "document";
    case "meeting":
    case "document":
    case "memory":
    case "decision":
      return kind;
  }
};

/**
 * Rebuild a source's canonical text from its chunks. Chunks tile the canonical
 * text, so writing each one at its own `charStart` and filling the gaps
 * reproduces the exact offsets every stored evidence span points into.
 */
export const reconstructSourceText = (
  chunks: ReadonlyArray<{ readonly charStart: number; readonly text: string }>,
): string => {
  let out = "";
  for (const chunk of chunks) {
    if (chunk.charStart > out.length) {
      out += "\n".repeat(chunk.charStart - out.length);
    }
    out += chunk.text;
  }
  return out;
};

interface SourceRow {
  readonly id: string;
  readonly kind: NomiorSourceKind;
  readonly title: string;
  readonly occurredAt: string | null;
  readonly ingestedAt: string;
}

interface ChunkTextRow {
  readonly charStart: number;
  readonly text: string;
}

interface DecisionRow {
  readonly id: string;
  readonly statement: string;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly sourceId: string;
  readonly evidenceCharStart: number | null;
  readonly evidenceCharEnd: number | null;
}

interface TaskRow extends DecisionRow {
  readonly status: string;
}

const unavailable = (operation: string) => (cause: unknown) =>
  new ContextUnavailableError({
    reason: `${operation} failed against the context store (${String(cause)})`,
  });

const toTaskStatus = (status: string): ContextDecision["status"] => {
  switch (status) {
    case "done":
      return "done";
    // The engine's `dropped` is the toolkit's `superseded`: both mean "no
    // longer live", and the toolkit catalog has no `dropped`.
    case "dropped":
      return "superseded";
    default:
      return "open";
  }
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const retrieval = yield* ContextRetrieval;
  const memories = yield* MemoryWriter;
  const claudeMemories = yield* ClaudeMemories;

  /**
   * Pull in whatever Claude Code has written for this project before answering.
   *
   * On the read path rather than in a daemon because that is the only place
   * that knows a project is being asked about, and the import is a stat per
   * note when nothing changed. Failures are swallowed for the same reason the
   * import is silent when there is nothing to import: a search must answer
   * from what the broker holds, even when the user's Claude config is
   * unreadable.
   */
  const importClaudeMemories = (scope: NomiorScope) =>
    scope.kind !== "project"
      ? Effect.void
      : sql<{ readonly workspaceRoot: string }>`
          SELECT workspace_root AS "workspaceRoot"
          FROM projection_projects
          WHERE project_id = ${scope.value} AND deleted_at IS NULL
        `.pipe(
          Effect.flatMap((rows) => {
            const workspaceRoot = rows[0]?.workspaceRoot;
            return workspaceRoot === undefined
              ? Effect.void
              : claudeMemories
                  .syncProject({ projectId: scope.value, workspaceRoot })
                  .pipe(Effect.asVoid);
          }),
          Effect.catchCause(() => Effect.void),
        );

  const loadSource = (id: string, scope: NomiorScope) =>
    sql<SourceRow>`
      SELECT
        s.id AS "id",
        s.kind AS "kind",
        s.title AS "title",
        s.occurred_at AS "occurredAt",
        s.ingested_at AS "ingestedAt"
      FROM nomior_sources s
      WHERE s.id = ${id}
        AND EXISTS (
          SELECT 1 FROM nomior_source_scopes sc
          WHERE sc.source_id = s.id
            AND sc.scope_kind = ${scope.kind}
            AND sc.scope_value = ${scope.value}
        )
    `.pipe(Effect.mapError(unavailable("context_get")));

  const search: ContextRetrievalPortShape["search"] = Effect.fn("RetrievalPortLive.search")(
    function* (request) {
      const scope = parseContextScope(request.scope);
      yield* importClaudeMemories(scope);
      const result = yield* retrieval
        .search({
          query: request.query,
          scope,
          budgetTokens: ENGINE_BUDGET_TOKENS,
          candidateLimit: request.limit,
        })
        .pipe(
          Effect.mapError(
            (error) => new ContextUnavailableError({ reason: `context_search: ${error.message}` }),
          ),
        );

      const topScore = result.snippets[0]?.score ?? 0;
      const snippets = result.snippets.map((snippet) => {
        const text =
          request.responseFormat === "detailed"
            ? `${snippet.contextualPrefix}\n${snippet.text}`
            : snippet.text;
        return {
          id: snippet.chunkId,
          sourceKind: toPortSourceKind(snippet.sourceKind),
          // The engine's citation string ("<title>" (meeting, 2026-08-12) §2
          // [chunk id]) is what makes a snippet quotable, so it travels as the
          // title rather than being dropped for the bare source title.
          title: snippet.citation,
          text,
          score: topScore > 0 ? snippet.score / topScore : 0,
          ...(snippet.occurredAt === null ? {} : { date: snippet.occurredAt }),
          span: { start: snippet.charStart, end: snippet.charEnd },
        } satisfies ContextSnippet;
      });

      return { snippets, totalMatches: snippets.length };
    },
  );

  const get: ContextRetrievalPortShape["get"] = Effect.fn("RetrievalPortLive.get")(
    function* (request) {
      const scope = parseContextScope(request.scope);
      // Search returns chunk ids (`<sourceId>/<ordinal>`); an agent may also pass
      // a bare source id. Both resolve, and both are scope-filtered — a source
      // outside the scope reads as not found so ids never prove existence across
      // scopes.
      const separator = request.id.lastIndexOf("/");
      const sourceId = separator > 0 ? request.id.slice(0, separator) : request.id;
      const rows = yield* loadSource(sourceId, scope);
      const source = rows[0];
      if (source === undefined) {
        return yield* new ContextSourceNotFoundError({ id: request.id });
      }
      const chunks = yield* sql<ChunkTextRow>`
      SELECT c.char_start AS "charStart", c.text AS "text"
      FROM nomior_chunks c
      WHERE c.source_id = ${source.id}
      ORDER BY c.ordinal ASC
    `.pipe(Effect.mapError(unavailable("context_get")));

      return {
        id: source.id as ContextId,
        scope: request.scope,
        sourceKind: toPortSourceKind(source.kind),
        title: source.title,
        text: reconstructSourceText(chunks),
        ...(source.occurredAt === null ? {} : { date: source.occurredAt }),
      };
    },
  );

  const decisions: ContextRetrievalPortShape["decisions"] = Effect.fn(
    "RetrievalPortLive.decisions",
  )(
    function* (request) {
      // Both queries below fail the same way; the mapError is hoisted onto the
      // generator result at the end of this Effect.fn.
      const scope = parseContextScope(request.project);
      const since = request.since ?? null;
      const scoped = sql`
      EXISTS (
        SELECT 1 FROM nomior_source_scopes sc
        WHERE sc.source_id = s.id
          AND sc.scope_kind = ${scope.kind}
          AND sc.scope_value = ${scope.value}
      )
    `;

      const decisionRows = yield* sql<DecisionRow>`
      SELECT
        d.id AS "id",
        d.statement AS "statement",
        d.decided_at AS "decidedAt",
        d.created_at AS "createdAt",
        d.source_id AS "sourceId",
        d.evidence_char_start AS "evidenceCharStart",
        d.evidence_char_end AS "evidenceCharEnd"
      FROM nomior_decisions d
      JOIN nomior_sources s ON s.id = d.source_id
      WHERE ${scoped}
        ${since === null ? sql`` : sql`AND coalesce(d.decided_at, d.created_at) >= ${since}`}
      ORDER BY coalesce(d.decided_at, d.created_at) DESC, d.id ASC
    `;

      const taskRows = yield* sql<TaskRow>`
      SELECT
        t.id AS "id",
        t.description AS "statement",
        t.due_at AS "decidedAt",
        t.created_at AS "createdAt",
        t.source_id AS "sourceId",
        t.status AS "status",
        t.evidence_char_start AS "evidenceCharStart",
        t.evidence_char_end AS "evidenceCharEnd"
      FROM nomior_tasks t
      JOIN nomior_sources s ON s.id = t.source_id
      WHERE ${scoped}
        ${since === null ? sql`` : sql`AND coalesce(t.due_at, t.created_at) >= ${since}`}
      ORDER BY coalesce(t.due_at, t.created_at) DESC, t.id ASC
    `;

      const evidenceOf = (row: DecisionRow): ContextDecision["evidence"] => [
        {
          sourceId: row.sourceId as ContextId,
          ...(row.evidenceCharStart === null || row.evidenceCharEnd === null
            ? {}
            : { span: { start: row.evidenceCharStart, end: row.evidenceCharEnd } }),
        },
      ];

      return [
        ...decisionRows.map(
          (row) =>
            ({
              id: row.id as ContextId,
              kind: "decision",
              statement: row.statement,
              decidedAt: row.decidedAt ?? row.createdAt,
              evidence: evidenceOf(row),
            }) satisfies ContextDecision,
        ),
        ...taskRows.map(
          (row) =>
            ({
              id: row.id as ContextId,
              kind: "task",
              statement: row.statement,
              decidedAt: row.decidedAt ?? row.createdAt,
              status: toTaskStatus(row.status),
              evidence: evidenceOf(row),
            }) satisfies ContextDecision,
        ),
      ];
    },
    Effect.mapError(unavailable("context_decisions")),
  );

  const remember: ContextRetrievalPortShape["remember"] = Effect.fn("RetrievalPortLive.remember")(
    function* (request) {
      const receipt = yield* memories
        .write({
          source: "context-tool",
          scope: parseContextScope(request.scope),
          kind: "note",
          text: request.text,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ContextUnavailableError({ reason: `context_remember: ${error.message}` }),
          ),
        );
      return { sourceId: receipt.sourceId, created: receipt.created };
    },
  );

  /**
   * A thread's own project, from upstream's thread projection. Fails with
   * `ContextUnavailableError` when the projection cannot be read: "the lookup
   * broke" and "this thread has no project" are different answers, and
   * `authorizeScope` must not treat the first as the second.
   */
  const projectForThread = (
    threadId: string,
  ): Effect.Effect<Option.Option<ContextScope>, ContextUnavailableError> =>
    sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId"
      FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `.pipe(
      Effect.mapError(unavailable("thread scope lookup")),
      Effect.map((rows) => {
        const projectId = rows[0]?.projectId;
        return projectId === undefined
          ? Option.none<ContextScope>()
          : Option.some(formatContextScope({ kind: "project", value: projectId }));
      }),
    );

  /**
   * A thread's scope is its project. Read from upstream's own thread
   * projection, so a thread created in the normal UI already has a context
   * scope with nothing extra to configure. A failed lookup reads as "no
   * scope", which the toolkit turns into `ContextScopeRequiredError` — the
   * fail-closed answer for the implicit path.
   */
  const defaultScopeForThread: ContextRetrievalPortShape["defaultScopeForThread"] = Effect.fn(
    "RetrievalPortLive.defaultScopeForThread",
  )(function* (threadId) {
    return yield* projectForThread(threadId).pipe(
      Effect.orElseSucceed(() => Option.none<ContextScope>()),
    );
  });

  /**
   * Enforces the fork's scope invariant ("a query in one project must never
   * surface another project's data") at the one place an agent can name a
   * scope itself.
   *
   * Fail-closed in both directions:
   * - a thread that belongs to project A may not name project B;
   * - a thread with no resolvable project may not name any scope at all.
   *   Resolving nothing is the absence of an authority to check against, not a
   *   grant of every scope — otherwise a session whose projection row is
   *   missing or soft-deleted would read wider than a normal one, and the
   *   implicit path (`ContextScopeRequiredError`) would be the only guarded
   *   one.
   *
   * Customer and capsule scopes cross projects by design and stay open for a
   * thread that does have a project — Nomior is single-user, and the deny that
   * matters there is the accidental project-to-project one.
   */
  const authorizeScope: ContextRetrievalPortShape["authorizeScope"] = Effect.fn(
    "RetrievalPortLive.authorizeScope",
  )(function* (request) {
    const threadScope = yield* projectForThread(request.threadId);
    if (Option.isNone(threadScope)) {
      return yield* new ContextScopeDeniedError({
        threadId: request.threadId,
        scope: request.scope,
      });
    }
    const requested = parseContextScope(request.scope);
    if (requested.kind !== "project") {
      return;
    }
    const owned = parseContextScope(threadScope.value);
    if (owned.kind === "project" && owned.value !== requested.value) {
      return yield* new ContextScopeDeniedError({
        threadId: request.threadId,
        scope: request.scope,
      });
    }
  });

  return ContextRetrievalPort.of({
    search,
    get,
    decisions,
    remember,
    defaultScopeForThread,
    authorizeScope,
  });
});

/**
 * The layer `mcp/toolkits/nomior/handlers.ts` provides in place of
 * `RetrievalPort.layerUnavailable`. Requires `SqlClient`, `ContextRetrieval`,
 * `MemoryWriter` and `ClaudeMemories` — supplied by
 * `NomiorRuntime.NomiorContextLive`.
 */
export const ContextRetrievalPortLive = Layer.effect(ContextRetrievalPort, make);
