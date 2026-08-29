/**
 * The context handlers on the real broker.
 *
 * The one behaviour worth pinning is the boundary: the panel names a project
 * and gets that project's material, never a neighbour's. A fake retrieval port
 * would only prove the handler passes a string along, so this builds
 * `NomiorContextLive` and ingests two projects for real.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { SourceInput } from "../context/Model.ts";
import { NomiorProjects } from "../projects/NomiorProjects.ts";
import { listProjects, searchContext } from "./contextHandlers.ts";

const ALPHA = ProjectId.make("proj-alpha");
const BETA = ProjectId.make("proj-beta");

const PROJECTS = NomiorProjects.layerStatic([
  { projectId: ALPHA, title: "Alpha", workspaceRoot: "/w/alpha" },
  { projectId: BETA, title: "Beta", workspaceRoot: "/w/beta" },
]);

const meeting = (project: ProjectId, externalId: string, text: string): SourceInput => ({
  kind: "meeting",
  externalId,
  title: "Retrieval planning",
  occurredAt: "2026-08-12T10:00:00.000Z",
  scopes: [{ kind: "project", value: project }],
  segments: [{ text }],
});

const layer = it.layer(
  Layer.mergeAll(NomiorContextLive, PROJECTS).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

layer("nomior context handlers", (it) => {
  it.effect("lists the projects the picker offers", () =>
    Effect.gen(function* () {
      const { projects } = yield* listProjects();
      assert.deepStrictEqual(
        projects.map((project) => project.title),
        ["Alpha", "Beta"],
      );
    }),
  );

  it.effect("answers with the named project's material only", () =>
    Effect.gen(function* () {
      const ingest = yield* ContextIngest;
      yield* ingest.ingestSource(
        meeting(ALPHA, "alpha-1", "We agreed the broker ships with reciprocal rank fusion."),
      );
      yield* ingest.ingestSource(
        meeting(BETA, "beta-1", "The other client also wants reciprocal rank fusion."),
      );
      yield* (yield* EmbeddingWorker).awaitIdle;

      const alpha = yield* searchContext({ query: "reciprocal rank fusion", projectId: ALPHA });
      assert.isAbove(alpha.snippets.length, 0);
      for (const snippet of alpha.snippets) {
        assert.notInclude(snippet.excerpt, "other client");
      }
    }),
  );
});
