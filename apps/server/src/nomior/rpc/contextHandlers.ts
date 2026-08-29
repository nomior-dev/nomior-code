/**
 * Handlers for the context and memory RPC methods.
 *
 * These live outside `ws.ts` so the fork's touch on that upstream file stays a
 * single spread. Every handler here converts its service's typed failures into
 * the one wire error the panels understand.
 *
 * Scope: the retrieval port takes a required scope and has no "everything"
 * search, so the panel picks a project and this searches that project. The MCP
 * toolkit resolves the same scope from the calling thread instead; that gate is
 * untouched.
 *
 * @module nomior/rpc/contextHandlers
 */
import { NomiorRequestError, type NomiorContextSnippet, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseCitation } from "../context/Retrieval.ts";
import { formatContextScope } from "../context/RetrievalPortLive.ts";
import { redactSecrets } from "../context/redactSecrets.ts";
import { NomiorProjects } from "../projects/NomiorProjects.ts";
import * as RetrievalPort from "../context/RetrievalPort.ts";

/** What the panel renders for one query. */
const SEARCH_LIMIT = 12;

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

/** The project picker's options: every project this environment still has. */
export const listProjects = Effect.fn("nomior.rpc.listProjects")(function* () {
  const projects = yield* NomiorProjects;
  const rows = yield* projects.list.pipe(Effect.mapError(unavailable));
  return { projects: rows.map((project) => ({ id: project.projectId, title: project.title })) };
});

export const searchContext = Effect.fn("nomior.rpc.searchContext")(function* (input: {
  readonly query: string;
  readonly projectId: ProjectId;
}) {
  const port = yield* RetrievalPort.ContextRetrievalPort;
  const response = yield* port
    .search({
      query: input.query,
      scope: formatContextScope({ kind: "project", value: input.projectId }),
      limit: SEARCH_LIMIT,
      responseFormat: "concise",
    })
    .pipe(Effect.mapError(unavailable));
  return { snippets: response.snippets.map(toWireSnippet) };
});
