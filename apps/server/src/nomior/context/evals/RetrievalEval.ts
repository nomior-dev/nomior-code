/**
 * RetrievalEval - the seeded golden-set harness for retrieval quality.
 *
 * Ingests the fixture corpus, waits for embeddings, runs every golden
 * question through `ContextRetrieval.search`, and scores recall@k at the
 * source level: recall@k = |expected sources among the sources of the top-k
 * snippets| / |expected sources|.
 *
 * Run it before and after any retrieval change — a new embedding model, a
 * reranker, different fusion. The gate values in `RECALL_GATES` are asserted
 * by the colocated test, so a regression fails CI rather than shipping
 * quietly.
 *
 * Scope honestly stated: this is a smoke test, not a measure. The 16
 * questions currently score 1.00 at every k against an 8-source fixture
 * corpus, so the gates below are floors with little discriminating power —
 * up to 2 questions can leave top-1 before r@1 trips. The real quality gate
 * is the M1 golden set (25+ questions over real minutes data, per PLAN.md);
 * when it lands, grow this corpus or point the harness at it.
 *
 * @module RetrievalEval
 */
import * as Effect from "effect/Effect";

import { EmbeddingWorker } from "../Embeddings.ts";
import { ContextIngest } from "../Ingest.ts";
import { ContextRetrieval } from "../Retrieval.ts";
import { evalCorpus } from "./fixtures.ts";
import { goldenQuestions, type GoldenQuestion } from "./golden.ts";

export const RECALL_KS = [1, 3, 5] as const;
export type RecallK = (typeof RECALL_KS)[number];

/** Macro-recall floors the eval must hold. Raise them, never lower them. */
export const RECALL_GATES: Readonly<Record<RecallK, number>> = {
  1: 0.85,
  3: 0.95,
  5: 1,
};

export interface QuestionResult {
  readonly id: string;
  readonly query: string;
  readonly expected: ReadonlyArray<string>;
  readonly topSources: ReadonlyArray<string>;
  readonly recall: Readonly<Record<RecallK, number>>;
}

export interface EvalSummary {
  readonly questions: ReadonlyArray<QuestionResult>;
  readonly macroRecall: Readonly<Record<RecallK, number>>;
}

const recallAtK = (
  expected: ReadonlySet<string>,
  rankedSources: ReadonlyArray<string>,
  k: number,
): number => {
  if (expected.size === 0) {
    return 1;
  }
  const seen = new Set(rankedSources.slice(0, k));
  let hit = 0;
  for (const id of expected) {
    if (seen.has(id)) {
      hit += 1;
    }
  }
  return hit / expected.size;
};

const scoreQuestion = (
  question: GoldenQuestion,
  externalIdBySourceId: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    const retrieval = yield* ContextRetrieval;
    const result = yield* retrieval.search({
      query: question.query,
      scope: question.scope,
    });
    // Source order of the snippet ranking, deduplicated.
    const topSources = [
      ...new Set(
        result.snippets.map(
          (snippet) => externalIdBySourceId.get(snippet.sourceId) ?? snippet.sourceId,
        ),
      ),
    ];
    const expected = new Set(question.expected);
    return {
      id: question.id,
      query: question.query,
      expected: question.expected,
      topSources,
      recall: {
        1: recallAtK(expected, topSources, 1),
        3: recallAtK(expected, topSources, 3),
        5: recallAtK(expected, topSources, 5),
      },
    } satisfies QuestionResult;
  });

export const runRetrievalEval = Effect.gen(function* () {
  const ingest = yield* ContextIngest;
  const worker = yield* EmbeddingWorker;

  const externalIdBySourceId = new Map<string, string>();
  for (const source of evalCorpus) {
    const result = yield* ingest.ingestSource(source);
    externalIdBySourceId.set(result.sourceId, source.externalId ?? result.sourceId);
  }
  yield* worker.awaitIdle;

  const questions: Array<QuestionResult> = [];
  for (const question of goldenQuestions) {
    questions.push(yield* scoreQuestion(question, externalIdBySourceId));
  }

  const macro = (k: RecallK) =>
    questions.reduce((sum, question) => sum + question.recall[k], 0) / questions.length;

  return {
    questions,
    macroRecall: { 1: macro(1), 3: macro(3), 5: macro(5) },
  } satisfies EvalSummary;
});

const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

export const formatEvalTable = (summary: EvalSummary): string => {
  const header = `${pad("question", 22)} ${pad("r@1", 6)} ${pad("r@3", 6)} ${pad("r@5", 6)} top sources`;
  const divider = "-".repeat(header.length);
  const rows = summary.questions.map(
    (question) =>
      `${pad(question.id, 22)} ${pad(question.recall[1].toFixed(2), 6)} ${pad(
        question.recall[3].toFixed(2),
        6,
      )} ${pad(question.recall[5].toFixed(2), 6)} ${question.topSources.slice(0, 3).join(", ")}`,
  );
  const macro = `${pad("macro", 22)} ${pad(summary.macroRecall[1].toFixed(2), 6)} ${pad(
    summary.macroRecall[3].toFixed(2),
    6,
  )} ${pad(summary.macroRecall[5].toFixed(2), 6)} (${summary.questions.length} questions)`;
  return [header, divider, ...rows, divider, macro].join("\n");
};
