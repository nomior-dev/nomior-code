/**
 * golden - the golden question set for retrieval evals.
 *
 * Each question names the source(s) that must appear in the top results,
 * by external id (stable across ingests). Questions are phrased the way an
 * agent or a user would ask them — including RU inflections that differ from
 * the corpus surface forms — so the eval measures retrieval, not string
 * equality.
 *
 * @module golden
 */
import type { NomiorScope } from "../Model.ts";

import { EVAL_OTHER_PROJECT, EVAL_PROJECT } from "./fixtures.ts";

export interface GoldenQuestion {
  readonly id: string;
  readonly query: string;
  readonly scope: NomiorScope;
  /** External ids of the sources that answer the question. */
  readonly expected: ReadonlyArray<string>;
}

export const goldenQuestions: ReadonlyArray<GoldenQuestion> = [
  {
    id: "q01-launch-date",
    query: "when is the public launch",
    scope: EVAL_PROJECT,
    expected: ["eval-launch-meeting"],
  },
  {
    id: "q02-launch-marketing",
    query: "what does marketing need before the launch announcement",
    scope: EVAL_PROJECT,
    expected: ["eval-launch-meeting"],
  },
  {
    id: "q03-installer-rollback",
    query: "installer database snapshot rollback",
    scope: EVAL_PROJECT,
    expected: ["eval-launch-meeting"],
  },
  {
    id: "q04-rrf",
    query: "how does retrieval fuse BM25 and dense results",
    scope: EVAL_PROJECT,
    expected: ["eval-broker-design"],
  },
  {
    id: "q05-evidence-spans",
    query: "what are evidence spans character offsets",
    scope: EVAL_PROJECT,
    expected: ["eval-broker-design"],
  },
  {
    id: "q06-token-budget",
    query: "who enforces the token budget for snippets",
    scope: EVAL_PROJECT,
    expected: ["eval-broker-design"],
  },
  {
    id: "q07-granola-terms",
    query: "can we use Granola commercially",
    scope: EVAL_PROJECT,
    expected: ["eval-granola-email"],
  },
  {
    id: "q08-granola-partnership",
    query: "partnership agreement before public release",
    scope: EVAL_PROJECT,
    expected: ["eval-granola-email"],
  },
  {
    id: "q09-anarlog-reading",
    query: "как коннектор читает данные Anarlog",
    scope: EVAL_PROJECT,
    expected: ["eval-anarlog-meeting"],
  },
  {
    id: "q10-diarization",
    query: "почему не Sortformer для диаризации",
    scope: EVAL_PROJECT,
    expected: ["eval-anarlog-meeting"],
  },
  {
    id: "q11-schema-change",
    query: "что делаем при смене схемы базы Anarlog",
    scope: EVAL_PROJECT,
    expected: ["eval-anarlog-meeting"],
  },
  {
    id: "q12-pricing-principle",
    query: "что бесплатно а что платно в тарифах",
    scope: EVAL_PROJECT,
    expected: ["eval-pricing-doc"],
  },
  {
    id: "q13-pro-price",
    query: "сколько стоит тариф Pro",
    scope: EVAL_PROJECT,
    expected: ["eval-pricing-doc"],
  },
  {
    id: "q14-embedding-model",
    query: "какая embedding модель по умолчанию",
    scope: EVAL_PROJECT,
    expected: ["eval-embedding-memory"],
  },
  {
    id: "q15-review-ci-gate",
    query: "why did the review verdict gate fail on CI",
    scope: EVAL_PROJECT,
    expected: ["eval-review-session"],
  },
  {
    id: "q16-scope-isolation",
    query: "launch date decision",
    scope: EVAL_OTHER_PROJECT,
    expected: ["eval-other-project-meeting"],
  },
];
