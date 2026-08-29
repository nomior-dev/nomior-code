/**
 * Nomior migration runner.
 *
 * Mirrors the upstream `persistence/Migrations.ts` structure but tracks its
 * migrations in a separate `nomior_sql_migrations` table so the fork never
 * competes with upstream migration ids during syncs. Runs against the same
 * SqlClient (same database file) the upstream layer provides.
 */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Migration0001 from "./Migrations/001_NomiorSchedulerState.ts";
import Migration0002 from "./Migrations/002_NomiorReviewJobs.ts";

export const nomiorMigrationEntries = [
  [1, "NomiorSchedulerState", Migration0001],
  [2, "NomiorReviewJobs", Migration0002],
] as const;

const makeLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      nomiorMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export const runNomiorMigrations = Effect.fn("runNomiorMigrations")(function* () {
  const executedMigrations = yield* run({
    loader: makeLoader(),
    table: "nomior_sql_migrations",
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Nomior database schema is current")
    : Effect.log("Nomior migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

/**
 * Layer that runs the Nomior migrations when built. Compose after the
 * upstream sqlite layer (any layer providing `SqlClient`).
 */
export const NomiorMigrationsLive = Layer.effectDiscard(runNomiorMigrations());
