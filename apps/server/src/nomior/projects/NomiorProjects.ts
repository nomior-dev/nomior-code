/**
 * The one answer to "which T3 project is this?".
 *
 * Nomior's surfaces each arrive at a project from a different direction: the
 * context panel is handed a `ProjectId`, a review job knows only `owner/name`
 * on a forge, and the memory reader needs a checkout path to look under. All
 * three resolve here so they cannot disagree about what a project is.
 *
 * A project's repository identity is not stored — `projection_projects` keeps
 * `workspace_root` and nothing about remotes — so `byRepo` resolves each
 * project's checkout through `RepositoryIdentityResolver`, which caches and is
 * the same resolver the rest of the server reads identities through. A project
 * whose checkout has no remote, or whose remote names another repo, simply does
 * not match; nothing is guessed from directory names.
 *
 * @module nomior/projects/NomiorProjects
 */
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";

export interface NomiorProject {
  readonly projectId: ProjectId;
  readonly title: string;
  /** Absolute path to the checkout. The memory reader keys off this. */
  readonly workspaceRoot: string;
}

export interface NomiorProjectsShape {
  /** Live projects, most recently updated first. Deleted ones are excluded. */
  readonly list: Effect.Effect<ReadonlyArray<NomiorProject>, PersistenceSqlError>;
  readonly byId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<NomiorProject>, PersistenceSqlError>;
  /**
   * The project whose checkout points at `owner/name`, if one does.
   *
   * Comparison is case-insensitive: forges treat repository names that way and
   * a remote URL's casing is not something the user chose.
   */
  readonly byRepo: (
    repo: string,
  ) => Effect.Effect<Option.Option<NomiorProject>, PersistenceSqlError>;
}

/** A project plus the repository its checkout points at, for the static layer. */
export interface StaticNomiorProject extends NomiorProject {
  readonly repo?: string | undefined;
}

export class NomiorProjects extends Context.Service<NomiorProjects, NomiorProjectsShape>()(
  "t3/nomior/projects/NomiorProjects",
) {
  /**
   * Fixed projects, for tests that need a lookup and not a database plus a git
   * checkout. `repo` stands in for what the identity resolver would report.
   */
  static readonly layerStatic = (projects: ReadonlyArray<StaticNomiorProject>) =>
    Layer.succeed(NomiorProjects, makeStatic(projects));
}

interface ProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

/** `owner/name`, lowercased, or null when the identity names no repository. */
const repoKeyOf = (owner: string | undefined, name: string | undefined): string | null =>
  owner === undefined || name === undefined ? null : `${owner}/${name}`.toLowerCase();

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identities = yield* RepositoryIdentityResolver;

  const list: NomiorProjectsShape["list"] = sql<ProjectRow>`
    SELECT project_id AS "projectId", title AS "title", workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        projectId: ProjectId.make(row.projectId),
        title: row.title,
        workspaceRoot: row.workspaceRoot,
      })),
    ),
    Effect.mapError(toPersistenceSqlError("NomiorProjects.list")),
  );

  const byId: NomiorProjectsShape["byId"] = Effect.fn("NomiorProjects.byId")(function* (projectId) {
    const projects = yield* list;
    return Option.fromNullishOr(projects.find((project) => project.projectId === projectId));
  });

  const byRepo: NomiorProjectsShape["byRepo"] = Effect.fn("NomiorProjects.byRepo")(
    function* (repo) {
      const wanted = repo.trim().toLowerCase();
      if (wanted.length === 0) return Option.none<NomiorProject>();

      const projects = yield* list;
      for (const project of projects) {
        const identity = yield* identities.resolve(project.workspaceRoot);
        if (identity === null) continue;
        if (repoKeyOf(identity.owner, identity.name) === wanted) return Option.some(project);
      }
      return Option.none<NomiorProject>();
    },
  );

  return NomiorProjects.of({ list, byId, byRepo });
});

const makeStatic = (projects: ReadonlyArray<StaticNomiorProject>): NomiorProjectsShape => {
  const strip = ({ repo: _repo, ...project }: StaticNomiorProject): NomiorProject => project;
  return {
    list: Effect.succeed(projects.map(strip)),
    byId: (projectId) =>
      Effect.succeed(
        Option.fromNullishOr(projects.find((project) => project.projectId === projectId)).pipe(
          Option.map(strip),
        ),
      ),
    byRepo: (repo) => {
      const wanted = repo.trim().toLowerCase();
      return Effect.succeed(
        Option.fromNullishOr(
          projects.find((project) => project.repo?.toLowerCase() === wanted),
        ).pipe(Option.map(strip)),
      );
    },
  };
};

/** Requires `SqlClient` and upstream's `RepositoryIdentityResolver`. */
export const layer = Layer.effect(NomiorProjects, make);
