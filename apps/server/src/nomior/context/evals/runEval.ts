/**
 * runEval - CLI entry for the retrieval eval: `pnpm nomior:eval-retrieval`.
 *
 * Runs the golden set against an in-memory database and prints the recall
 * table. Exits non-zero when a macro-recall gate is missed, so it can guard
 * CI as well as local experiments.
 *
 * @module runEval
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ContextBrokerLive } from "../ContextBroker.ts";
import { formatEvalTable, RECALL_GATES, RECALL_KS, runRetrievalEval } from "./RetrievalEval.ts";

const program = Effect.gen(function* () {
  const summary = yield* runRetrievalEval;
  yield* Console.log(formatEvalTable(summary));

  const misses = RECALL_KS.filter((k) => summary.macroRecall[k] < RECALL_GATES[k]);
  if (misses.length > 0) {
    for (const k of misses) {
      yield* Console.error(
        `GATE MISSED: macro recall@${k} = ${summary.macroRecall[k].toFixed(2)} < ${RECALL_GATES[k]}`,
      );
    }
    return 1;
  }
  yield* Console.log("All recall gates passed.");
  return 0;
});

const runnable = program.pipe(
  Effect.provide(
    ContextBrokerLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

Effect.runPromise(runnable).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  },
);
