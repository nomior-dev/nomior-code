import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorMigrationsLive } from "./Migrations.ts";

/**
 * In-memory sqlite with both the upstream and the Nomior migrations applied.
 * Test-only convenience; production composition adds `NomiorMigrationsLive`
 * next to the upstream sqlite layer instead.
 */
export const NomiorSqlitePersistenceMemory = Layer.provideMerge(
  NomiorMigrationsLive,
  SqlitePersistenceMemory,
);
