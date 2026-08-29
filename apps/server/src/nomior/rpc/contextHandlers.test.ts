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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { SourceInput } from "../context/Model.ts";
import { ClaudeConfigRoots, claudeProjectSlug } from "../memory/ClaudeMemories.ts";
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
    Layer.provideMerge(NodeServices.layer),
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

  it.effect("imports the project's Claude memories on the way to answering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-config-" });
        const memory = path.join(root, "projects", claudeProjectSlug("/w/alpha"), "memory");
        yield* fs.makeDirectory(memory, { recursive: true });
        yield* fs.writeFileString(
          path.join(memory, "ports.md"),
          "---\nname: derived-ports\ndescription: Dev ports\n---\n\nDev ports derive from the worktree path.\n",
        );
        // The handler resolves the checkout from the project projection, which
        // is what makes the import automatic — nothing asked for it.
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES ('proj-alpha', 'Alpha', '/w/alpha', '[]',
                  '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', NULL)
        `;

        const found = yield* searchContext({
          query: "worktree path ports",
          projectId: ALPHA,
        }).pipe(Effect.provideService(ClaudeConfigRoots, [root]));

        assert.isAbove(found.snippets.length, 0, "the imported memory must be searchable");
        assert.include(found.snippets[0]?.excerpt ?? "", "worktree path");
      }),
    ),
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
