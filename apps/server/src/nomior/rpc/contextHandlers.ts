/**
 * Handlers for the context and memory RPC methods.
 *
 * These live outside `ws.ts` so the fork's touch on that upstream file stays a
 * single spread. Every handler here converts its service's typed failures into
 * the one wire error the panels understand.
 *
 * Scope, and why this differs from the MCP toolkit: the retrieval port takes a
 * required scope and has no "everything" search. The MCP toolkit resolves that
 * scope from the calling thread and fails closed, which is right for an agent —
 * it must not read across a boundary its thread was not granted. An RPC caller
 * is the authenticated owner of this environment, browsing their own data, so
 * that rule does not transfer: this searches every scope the broker holds and
 * merges the results. The MCP gate is untouched.
 *
 * @module nomior/rpc/contextHandlers
 */
import {
  NomiorRequestError,
  type NomiorContextSnippet,
  type NomiorMemoryCandidate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { parseCitation } from "../context/Retrieval.ts";
import { formatContextScope } from "../context/RetrievalPortLive.ts";
import { redactSecrets } from "../context/redactSecrets.ts";
import type { NomiorScopeKind } from "../context/Model.ts";
import * as RetrievalPort from "../context/RetrievalPort.ts";
import {
  MemoryCandidateId,
  type MemoryCandidateStoreShape,
  type StoredMemoryCandidate,
} from "../memory/MemoryCandidateStore.ts";

/**
 * Candidates ranked per scope before merging. Generous relative to what the
 * panel shows, because the merge drops duplicates across overlapping scopes
 * (the same source is commonly both `project:x` and `capsule:x`).
 */
const PER_SCOPE_LIMIT = 20;

/** What the panel renders for one query. */
const MERGED_LIMIT = 12;

/** A snippet excerpt longer than this is padding, not evidence. */
const EXCERPT_MAX_CHARS = 480;

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;

/**
 * The engine's source kinds are the wire's source kinds, so this is a widening
 * cast rather than a mapping. Kept as one named function so a future divergence
 * has exactly one place to become a real mapping.
 */
const toWireSourceKind = (
  kind: RetrievalPort.ContextSourceKind,
): NomiorContextSnippet["sourceKind"] => kind;

/**
 * The port's `title` is the engine's citation, which repeats the kind, the date
 * and the chunk id — all of which the panel renders in its own columns. Show the
 * bare title instead, falling back to the whole citation if it ever stops
 * parsing, since a long label beats an empty one.
 */
const toDisplayTitle = (citation: string): string => parseCitation(citation)?.title ?? citation;

const toWireSnippet = (snippet: RetrievalPort.ContextSnippet): NomiorContextSnippet => ({
  id: snippet.id,
  sourceTitle: truncate(redactSecrets(toDisplayTitle(snippet.title)), 200),
  sourceKind: toWireSourceKind(snippet.sourceKind),
  // `date` is a full timestamp; the panel formats a day.
  sourceDate: snippet.date?.slice(0, 10) ?? "",
  excerpt: truncate(redactSecrets(snippet.text), EXCERPT_MAX_CHARS),
  score: snippet.score,
});

const unavailable = (cause: unknown): NomiorRequestError =>
  new NomiorRequestError({
    message:
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Context is unavailable.",
    // The broker being down is transient; the panel should keep its Retry.
    retryable: true,
  });

interface ScopeRow {
  readonly scope_kind: string;
  readonly scope_value: string;
}

/**
 * Every scope the broker holds. A source with no scope row is unreachable by
 * search in any case, so an empty list means an empty result, not an error.
 */
const listScopes = Effect.fn("nomior.rpc.listScopes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScopeRow>`
    SELECT DISTINCT scope_kind, scope_value FROM nomior_source_scopes
  `;
  return rows.map((row) =>
    formatContextScope({ kind: row.scope_kind as NomiorScopeKind, value: row.scope_value }),
  );
});

export const searchContext = Effect.fn("nomior.rpc.searchContext")(function* (input: {
  readonly query: string;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  const scopes = yield* listScopes().pipe(Effect.mapError(unavailable));

  // Highest score wins a duplicate: the same source can be reachable through
  // several scopes, and the panel must show it once.
  const bySnippetId = new Map<string, NomiorContextSnippet>();
  for (const scope of scopes) {
    const response = yield* port
      .search({ query: input.query, scope, limit: PER_SCOPE_LIMIT, responseFormat: "concise" })
      .pipe(Effect.mapError(unavailable));
    for (const snippet of response.snippets) {
      const wire = toWireSnippet(snippet);
      const seen = bySnippetId.get(wire.id);
      if (seen === undefined || wire.score > seen.score) bySnippetId.set(wire.id, wire);
    }
  }

  const snippets = [...bySnippetId.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MERGED_LIMIT);
  return { snippets };
});

/**
 * Producer plus its reference, as one line the panel can show under the text.
 * `originRef` is free-form (`repo@sha` for a review leg, a thread id for the
 * context tool), so it is shown verbatim rather than parsed.
 */
const describeCandidateSource = (candidate: StoredMemoryCandidate): string => {
  const producer = candidate.source === "review" ? "Review" : "Context tool";
  return candidate.originRef === null || candidate.originRef === ""
    ? producer
    : `${producer} — ${redactSecrets(candidate.originRef)}`;
};

const toWireCandidate = (candidate: StoredMemoryCandidate): NomiorMemoryCandidate => ({
  id: candidate.id,
  text: redactSecrets(candidate.text),
  source: describeCandidateSource(candidate),
  capturedAt: candidate.createdAt,
  status: candidate.status,
});

export const listMemoryCandidates = Effect.fn("nomior.rpc.listMemoryCandidates")(function* (
  store: MemoryCandidateStoreShape,
) {
  const candidates = yield* store.list({ status: "pending" }).pipe(Effect.mapError(unavailable));
  return { candidates: candidates.map(toWireCandidate) };
});

export const resolveMemoryCandidate = Effect.fn("nomior.rpc.resolveMemoryCandidate")(function* (
  store: MemoryCandidateStoreShape,
  input: { readonly id: string; readonly resolution: "approved" | "rejected" },
) {
  const id = MemoryCandidateId.make(input.id);
  yield* (input.resolution === "approved" ? store.approve(id) : store.reject(id)).pipe(
    Effect.mapError((cause) =>
      cause._tag === "NomiorMemoryCandidateNotFoundError" ||
      cause._tag === "NomiorMemoryCandidateScopeRequiredError"
        ? // Both describe this candidate, not the request: retrying is pointless.
          new NomiorRequestError({ message: cause.message, retryable: false })
        : unavailable(cause),
    ),
  );
});
