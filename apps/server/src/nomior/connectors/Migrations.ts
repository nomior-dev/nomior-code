/**
 * Nomior connector migrations — a fully additive migrator.
 *
 * Uses the same `Migrator.fromRecord` machinery as upstream's
 * `persistence/Migrations.ts` but tracks progress in its own table
 * (`nomior_connector_migrations`), so upstream can keep appending numeric
 * ids to `effect_sql_migrations` without ever colliding with ours. Zero
 * upstream files touched.
 *
 * Wiring: provide `NomiorConnectorMigrationsLive` anywhere after the
 * SqlClient layer (e.g. `Layer.provideMerge(NomiorConnectorMigrationsLive,
 * SqlitePersistence…)`).
 *
 * @module nomior/connectors/Migrations
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/001_ConnectorTables.ts";

export const nomiorConnectorMigrationEntries = [[1, "ConnectorTables", Migration0001]] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(
    nomiorConnectorMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const runNomiorConnectorMigrations = Effect.fn("runNomiorConnectorMigrations")(function* () {
  const executed = yield* run({ loader, table: "nomior_connector_migrations" });
  if (executed.length > 0) {
    yield* Effect.log("Nomior connector migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

export const NomiorConnectorMigrationsLive = Layer.effectDiscard(runNomiorConnectorMigrations());
