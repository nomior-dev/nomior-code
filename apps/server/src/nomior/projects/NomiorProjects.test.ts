import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { NomiorProjects, layer as NomiorProjectsLive } from "./NomiorProjects.ts";

const identity = (owner: string, name: string): RepositoryIdentity => ({
  canonicalKey: `github.com/${owner}/${name}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `git@github.com:${owner}/${name}.git`,
  },
  owner,
  name,
});

/**
 * `/w/music` has a remote; `/w/code` deliberately does not, so the scan has to
 * skip a checkout rather than fail on it.
 */
const IDENTITIES: Record<string, RepositoryIdentity> = {
  "/w/music": identity("nomior-dev", "nomior-music"),
};

const StubIdentities = Layer.succeed(
  RepositoryIdentityResolver,
  RepositoryIdentityResolver.of({ resolve: (cwd) => Effect.succeed(IDENTITIES[cwd] ?? null) }),
);

const layer = it.layer(
  NomiorProjectsLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(StubIdentities),
    Layer.provide(NodeServices.layer),
  ),
);

const seedProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES
      ('proj-code', 'Code', '/w/code', '[]', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', NULL),
      ('proj-music', 'Music', '/w/music', '[]', '2026-08-01T00:00:00.000Z', '2026-08-28T00:00:00.000Z', NULL),
      ('proj-gone', 'Gone', '/w/gone', '[]', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
  `;
});

describe("NomiorProjects.layerStatic", () => {
  it.effect("answers both lookups without a database, and never leaks its repo hint", () =>
    Effect.gen(function* () {
      const projects = yield* NomiorProjects;
      assert.strictEqual(
        Option.getOrNull(yield* projects.byRepo("nomior-dev/nomior-code"))?.projectId,
        "proj-a",
      );
      assert.isTrue(Option.isNone(yield* projects.byRepo("other/repo")));
      const listed = yield* projects.list;
      assert.deepStrictEqual(Object.keys(listed[0] ?? {}).sort(), [
        "projectId",
        "title",
        "workspaceRoot",
      ]);
    }).pipe(
      Effect.provide(
        NomiorProjects.layerStatic([
          {
            projectId: ProjectId.make("proj-a"),
            title: "Code",
            workspaceRoot: "/w/code",
            repo: "nomior-dev/nomior-code",
          },
        ]),
      ),
    ),
  );
});

layer("NomiorProjects", (it) => {
  it.effect("lists live projects newest first and resolves one by id", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const projects = yield* NomiorProjects;

      const listed = yield* projects.list;
      assert.deepStrictEqual(
        listed.map((project) => project.projectId),
        ["proj-code", "proj-music"],
      );

      assert.strictEqual(
        Option.getOrNull(yield* projects.byId(ProjectId.make("proj-music")))?.workspaceRoot,
        "/w/music",
      );
      // A deleted project is not a project.
      assert.isTrue(Option.isNone(yield* projects.byId(ProjectId.make("proj-gone"))));
    }),
  );

  it.effect("matches a repo to the checkout that points at it, ignoring case", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const projects = yield* NomiorProjects;

      assert.strictEqual(
        Option.getOrNull(yield* projects.byRepo("Nomior-Dev/Nomior-Music"))?.projectId,
        "proj-music",
      );
      // No checkout points at this one, and `/w/code` has no remote to compare.
      assert.isTrue(Option.isNone(yield* projects.byRepo("nomior-dev/nomior-estate")));
      assert.isTrue(Option.isNone(yield* projects.byRepo("   ")));
    }),
  );
});
