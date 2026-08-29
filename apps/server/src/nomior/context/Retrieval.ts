/**
 * Retrieval - scope-first hybrid search over the context broker.
 *
 * Pipeline: scope resolution → metadata filter → parallel BM25 (FTS5) and
 * dense (cosine over stored vectors) legs → reciprocal-rank fusion (k=60) →
 * rerank hook (identity by default) → hard token-budget enforcement.
 *
 * `search` returns bounded, cited snippets — never whole transcripts: every
 * snippet is one chunk (≤ ~1200 chars by construction, hard-capped below) and
 * the total is clipped to the token budget.
 *
 * @module Retrieval
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

import {
  cosineSimilarity,
  decodeVector,
  EmbeddingModelRegistry,
  type EmbeddingModel,
} from "./Embeddings.ts";
import {
  NomiorChunkId,
  type NomiorContextError,
  NomiorEmbeddingError,
  type NomiorScope,
  NomiorSourceId,
  type NomiorSourceKind,
  type RetrievedSnippet,
  type SearchResult,
  toNomiorContextSqlError,
} from "./Model.ts";

export const DEFAULT_BUDGET_TOKENS = 1800;
export const RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 40;
/** Belt-and-braces: chunking already bounds chunks well below this. */
const MAX_SNIPPET_CHARS = 2000;

export interface SearchOptions {
  readonly query: string;
  /** Required: retrieval is scope-first, nothing is searched unscoped. */
  readonly scope: NomiorScope;
  readonly budgetTokens?: number | undefined;
  readonly kinds?: ReadonlyArray<NomiorSourceKind> | undefined;
  /** Only sources dated (occurred_at, else ingested_at) at or after this. */
  readonly since?: string | undefined;
  readonly candidateLimit?: number | undefined;
}

export class ContextRetrieval extends Context.Service<
  ContextRetrieval,
  {
    readonly search: (
      options: SearchOptions,
    ) => Effect.Effect<SearchResult, NomiorContextError | NomiorEmbeddingError>;
  }
>()("t3/nomior/context/Retrieval/ContextRetrieval") {}

/**
 * Reranker - hook between fusion and budget enforcement.
 *
 * Identity by default; a cross-encoder reranker (top-50) lands as an
 * alternative layer with the same signature, running in its own worker.
 */
export class Reranker extends Context.Service<
  Reranker,
  {
    readonly rerank: (
      query: string,
      candidates: ReadonlyArray<RetrievedSnippet>,
    ) => Effect.Effect<ReadonlyArray<RetrievedSnippet>>;
  }
>()("t3/nomior/context/Retrieval/Reranker") {}

export const RerankerIdentity = Layer.succeed(Reranker, {
  rerank: (_query, candidates) => Effect.succeed(candidates),
});

// ===============================
// Pure pieces (unit-tested directly)
// ===============================

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Reciprocal-rank fusion: score(id) = Σ over rankings 1 / (k + rank), rank
 * 1-based. Ties break lexicographically for determinism.
 */
export const rrfFuse = (
  rankings: ReadonlyArray<ReadonlyArray<string>>,
  k: number = RRF_K,
): Array<{ readonly id: string; readonly score: number }> => {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [index, id] of ranking.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/**
 * FTS5 match expression: each query token becomes a quoted prefix term, OR'd
 * so partial matches still surface (fusion and bm25 handle precision). The
 * prefix star helps against RU/UK inflection with the unicode61 tokenizer.
 * Returns null when the query has no indexable tokens.
 *
 * Stopwords are kept: a term like `"the"*` matches most of the scope's index,
 * so query cost grows with corpus size before LIMIT applies. Acceptable at v1
 * scale; a stopword list or AND-of-rarest-terms is the lever if it shows up
 * in profiles.
 */
export const buildMatchExpression = (query: string): string | null => {
  const tokens = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token}"*`).join(" OR ");
};

export interface BudgetEnforcement {
  readonly snippets: ReadonlyArray<RetrievedSnippet>;
  readonly usedTokens: number;
  readonly truncated: boolean;
}

const snippetTokens = (snippet: RetrievedSnippet): number =>
  approxTokens(snippet.contextualPrefix) + approxTokens(snippet.text);

/**
 * Hard budget: keep snippets in rank order while they fit. When even the
 * first snippet does not fit, its text is cut so the caller gets a partial
 * result rather than an empty answer — unless the prefix alone already
 * exceeds the budget, in which case nothing fits and only the truncation
 * notice comes back. `usedTokens <= budgetTokens` always holds.
 */
export const enforceBudget = (
  candidates: ReadonlyArray<RetrievedSnippet>,
  budgetTokens: number,
): BudgetEnforcement => {
  const snippets: Array<RetrievedSnippet> = [];
  let usedTokens = 0;
  let truncated = false;
  for (const candidate of candidates) {
    const cost = snippetTokens(candidate);
    if (usedTokens + cost <= budgetTokens) {
      snippets.push(candidate);
      usedTokens += cost;
      continue;
    }
    if (snippets.length === 0) {
      const prefixTokens = approxTokens(candidate.contextualPrefix);
      const remainingChars = (budgetTokens - prefixTokens) * 4;
      if (remainingChars > 0) {
        const cut = { ...candidate, text: candidate.text.slice(0, remainingChars) };
        snippets.push(cut);
        usedTokens += snippetTokens(cut);
      }
    }
    truncated = true;
    break;
  }
  if (!truncated && snippets.length < candidates.length) {
    truncated = true;
  }
  return { snippets, usedTokens, truncated };
};

export const truncationNotice = (budgetTokens: number): string =>
  `Results truncated to fit the ${budgetTokens}-token budget — narrow your query ` +
  `(add a speaker, date, or more specific terms), filter by kind, or raise budgetTokens.`;

export const formatCitation = (snippet: {
  readonly title: string;
  readonly sourceKind: string;
  readonly occurredAt: string | null;
  readonly ordinal: number;
  readonly chunkId: string;
}): string => {
  const date = snippet.occurredAt?.slice(0, 10);
  const dated = date === undefined || date.length === 0 ? "" : `, ${date}`;
  return `"${snippet.title}" (${snippet.sourceKind}${dated}) §${snippet.ordinal + 1} [${snippet.chunkId}]`;
};

// ===============================
// Service
// ===============================

interface SnippetRow {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceKind: NomiorSourceKind;
  readonly title: string;
  readonly contextualPrefix: string;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly ordinal: number;
  readonly speaker: string | null;
  readonly occurredAt: string | null;
}

const makeContextRetrieval = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* EmbeddingModelRegistry;
  const reranker = yield* Reranker;

  /** Shared scope + metadata filter, joined against `nomior_sources s`. */
  const sourceFilter = (options: SearchOptions): Statement.Fragment =>
    sql.and([
      sql`EXISTS (
        SELECT 1 FROM nomior_source_scopes sc
        WHERE sc.source_id = s.id
          AND sc.scope_kind = ${options.scope.kind}
          AND sc.scope_value = ${options.scope.value}
      )`,
      ...(options.kinds === undefined || options.kinds.length === 0
        ? []
        : [sql.in("s.kind", options.kinds)]),
      ...(options.since === undefined
        ? []
        : [sql`coalesce(s.occurred_at, s.ingested_at) >= ${options.since}`]),
    ]);

  const bm25Leg = (options: SearchOptions, candidateLimit: number) =>
    Effect.gen(function* () {
      const matchExpression = buildMatchExpression(options.query);
      if (matchExpression === null) {
        return [] as ReadonlyArray<string>;
      }
      const rows = yield* sql<{ readonly chunkId: string }>`
        SELECT c.id AS "chunkId"
        FROM nomior_chunks_fts
        JOIN nomior_chunks c ON c.rowid = nomior_chunks_fts.rowid
        JOIN nomior_sources s ON s.id = c.source_id
        WHERE nomior_chunks_fts MATCH ${matchExpression}
          AND ${sourceFilter(options)}
        ORDER BY bm25(nomior_chunks_fts, 1.0, 0.5) ASC
        LIMIT ${candidateLimit}
      `.pipe(Effect.mapError(toNomiorContextSqlError("ContextRetrieval.bm25Leg")));
      return rows.map((row) => row.chunkId);
    });

  /**
   * Dense leg: brute-force cosine over the scope's stored vectors. Fine for
   * v1 scale (thousands of chunks per scope). Seam: with `sqlite-vec` loaded
   * (needs `allowExtension` on the client), replace this scan with a `vec0`
   * virtual-table KNN query — same inputs and output ranking, so only this
   * function changes. We deliberately avoid the native dep for now.
   *
   * Query embedding runs inline here — free for the hash model, but a real
   * model (EmbeddingGemma via the registry seam) would put per-query
   * inference on the request path. That swap must move `model.embed` behind
   * the same cancellable-worker discipline as chunk embedding and rerank.
   */
  const denseLeg = (options: SearchOptions, candidateLimit: number, model: EmbeddingModel) =>
    Effect.gen(function* () {
      const vectors = yield* model.embed([options.query]);
      const queryVector = vectors[0];
      if (queryVector === undefined) {
        return yield* new NomiorEmbeddingError({
          modelId: model.id,
          detail: "model returned no vector for the query",
        });
      }
      const rows = yield* sql<{ readonly chunkId: string; readonly vector: Uint8Array }>`
        SELECT e.chunk_id AS "chunkId", e.vector AS "vector"
        FROM nomior_embeddings e
        JOIN nomior_chunks c ON c.id = e.chunk_id
        JOIN nomior_sources s ON s.id = c.source_id
        WHERE e.model_id = ${model.id}
          AND ${sourceFilter(options)}
      `.pipe(Effect.mapError(toNomiorContextSqlError("ContextRetrieval.denseLeg")));
      return rows
        .map((row) => ({
          chunkId: row.chunkId,
          similarity: cosineSimilarity(queryVector, decodeVector(row.vector)),
        }))
        .filter((row) => row.similarity > 0)
        .sort(
          (a, b) =>
            b.similarity - a.similarity ||
            (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
        )
        .slice(0, candidateLimit)
        .map((row) => row.chunkId);
    });

  const loadSnippetRows = (chunkIds: ReadonlyArray<string>) =>
    chunkIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<SnippetRow>)
      : sql<SnippetRow>`
          SELECT
            c.id AS "chunkId",
            c.source_id AS "sourceId",
            s.kind AS "sourceKind",
            s.title AS "title",
            c.contextual_prefix AS "contextualPrefix",
            c.text AS "text",
            c.char_start AS "charStart",
            c.char_end AS "charEnd",
            c.ordinal AS "ordinal",
            c.speaker AS "speaker",
            s.occurred_at AS "occurredAt"
          FROM nomior_chunks c
          JOIN nomior_sources s ON s.id = c.source_id
          WHERE ${sql.in("c.id", chunkIds)}
        `.pipe(Effect.mapError(toNomiorContextSqlError("ContextRetrieval.loadSnippetRows")));

  const search = Effect.fn("ContextRetrieval.search")(function* (options: SearchOptions) {
    const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    const model = registry.active;

    const [bm25Ids, denseIds] = yield* Effect.all(
      [bm25Leg(options, candidateLimit), denseLeg(options, candidateLimit, model)],
      { concurrency: 2 },
    );

    const fused = rrfFuse([bm25Ids, denseIds]);
    const fusedTop = fused.slice(0, candidateLimit);
    const rows = yield* loadSnippetRows(fusedTop.map((entry) => entry.id));
    const rowsById = new Map(rows.map((row) => [row.chunkId, row]));

    const candidates: Array<RetrievedSnippet> = [];
    for (const entry of fusedTop) {
      const row = rowsById.get(entry.id);
      if (row === undefined) {
        continue;
      }
      candidates.push({
        sourceId: NomiorSourceId.make(row.sourceId),
        chunkId: NomiorChunkId.make(row.chunkId),
        sourceKind: row.sourceKind,
        title: row.title,
        contextualPrefix: row.contextualPrefix,
        text: row.text.slice(0, MAX_SNIPPET_CHARS),
        charStart: row.charStart,
        charEnd: row.charEnd,
        ordinal: row.ordinal,
        speaker: row.speaker,
        occurredAt: row.occurredAt,
        score: entry.score,
        citation: formatCitation(row),
      });
    }

    const reranked = yield* reranker.rerank(options.query, candidates);
    const budget = enforceBudget(reranked, budgetTokens);

    return {
      snippets: budget.snippets,
      budgetTokens,
      usedTokens: budget.usedTokens,
      truncated: budget.truncated,
      notice: budget.truncated ? truncationNotice(budgetTokens) : null,
    } satisfies SearchResult;
  });

  return { search } satisfies ContextRetrieval["Service"];
});

export const ContextRetrievalLive = Layer.effect(ContextRetrieval, makeContextRetrieval);
