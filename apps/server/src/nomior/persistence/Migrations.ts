/**
 * The Nomior migration runner — the ONE place Nomior schema changes are
 * registered.
 *
 * Mirrors the upstream `persistence/Migrations.ts` structure but tracks its
 * migrations in a separate `nomior_sql_migrations` table, so upstream can keep
 * appending ids to `effect_sql_migrations` without ever colliding with ours on
 * a filename or a registry slot. Runs against the same SqlClient (same
 * database file) the upstream layer provides, right after upstream's own
 * migrations — see `persistence/Layers/Sqlite.ts`.
 *
 * Adding a migration: create `./Migrations/<next id>_<Name>.ts` and append one
 * entry below. Never add a Nomior migration to the upstream registry.
 */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";

import Migration0001 from "./Migrations/001_NomiorSchedulerState.ts";
import Migration0002 from "./Migrations/002_NomiorReviewJobs.ts";
import Migration0003 from "./Migrations/003_NomiorContextBroker.ts";
import Migration0004 from "./Migrations/004_NomiorConnectorTables.ts";
import Migration0005 from "./Migrations/005_NomiorMemoryCandidates.ts";
import Migration0006 from "./Migrations/006_NomiorPanelSurfaces.ts";
import Migration0007 from "./Migrations/007_NomiorSchedulerPreferences.ts";
import Migration0008 from "./Migrations/008_NomiorConnectorSyncRuns.ts";
import Migration0009 from "./Migrations/009_NomiorReviewPullRequestState.ts";

export const nomiorMigrationEntries = [
  [1, "NomiorSchedulerState", Migration0001],
  [2, "NomiorReviewJobs", Migration0002],
  [3, "NomiorContextBroker", Migration0003],
  [4, "NomiorConnectorTables", Migration0004],
  [5, "NomiorMemoryCandidates", Migration0005],
  [6, "NomiorPanelSurfaces", Migration0006],
  [7, "NomiorSchedulerPreferences", Migration0007],
  [8, "NomiorConnectorSyncRuns", Migration0008],
  [9, "NomiorReviewPullRequestState", Migration0009],
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(
    nomiorMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const runNomiorMigrations = Effect.fn("runNomiorMigrations")(function* () {
  const executedMigrations = yield* run({ loader, table: "nomior_sql_migrations" });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Nomior database schema is current")
    : Effect.log("Nomior migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
