import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ContextBrokerLive } from "../ContextBroker.ts";
import { formatEvalTable, RECALL_GATES, RECALL_KS, runRetrievalEval } from "./RetrievalEval.ts";

const layer = it.layer(
  ContextBrokerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

layer("RetrievalEval golden set", (it) => {
  it.effect("holds the macro recall gates", () =>
    Effect.gen(function* () {
      const summary = yield* runRetrievalEval;

      for (const k of RECALL_KS) {
        assert.isAtLeast(
          summary.macroRecall[k],
          RECALL_GATES[k],
          `macro recall@${k} regressed:\n${formatEvalTable(summary)}`,
        );
      }

      // The scope-isolation question must be exact: nothing from the main
      // project may leak into the other project's scope.
      const isolation = summary.questions.find((question) => question.id === "q16-scope-isolation");
      assert.ok(isolation);
      assert.deepStrictEqual(isolation!.topSources, ["eval-other-project-meeting"]);
    }),
  );
});
