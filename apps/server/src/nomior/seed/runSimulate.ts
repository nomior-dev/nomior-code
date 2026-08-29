/**
 * runSimulate - CLI entry for `pnpm nomior:simulate [--db <path>]`.
 *
 * Seeds a throwaway in-memory database and drives the whole product through
 * it, printing a report a human can read and exiting non-zero when an
 * invariant breaks. With `--db` it simulates against an existing seeded file
 * instead (it still seeds first — the seeder is idempotent).
 *
 * @module nomior/seed/runSimulate
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { MemoryCandidateSinkLive } from "../memory/ReviewSinkLive.ts";
import * as ReviewJobStore from "../review/ReviewJobStore.ts";
import * as InstanceScheduler from "../scheduler/InstanceScheduler.ts";
import { DeterministicSeedRuntime } from "./deterministic.ts";
import { SEED_NOW } from "./scenario.ts";
import { NomiorSeedServices, seedNomior } from "./seed.ts";
import { formatSimulationReport, runSimulation, simulationExitCode } from "./simulate.ts";

const USAGE = `Usage: nomior:simulate [--db <path>]

  --db <path>   Simulate against this SQLite file. Defaults to a throwaway
                in-memory database, seeded on the spot.
  --help        Print this.`;

/**
 * Seed services plus what only the simulation needs: the review store, the
 * memory sink review findings land in, and a scheduler that is switched ON
 * (it ships off — a disabled scheduler has nothing to demonstrate).
 */
const SimulationServices = Layer.mergeAll(
  ReviewJobStore.layer,
  MemoryCandidateSinkLive,
  InstanceScheduler.layer.pipe(
    Layer.provide(InstanceScheduler.InstanceSchedulerConfig.layerStatic({ enabled: true })),
  ),
).pipe(Layer.provideMerge(NomiorSeedServices));

const parseArgs = (argv: ReadonlyArray<string>) => {
  let dbPath: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    }
  }
  return { dbPath, help };
};

const program = Effect.gen(function* () {
  const summary = yield* seedNomior({ reset: false });
  yield* Console.log(
    `Seeded scenario: ${summary.sources} sources, ${summary.chunks} chunks, ` +
      `${summary.reviewJobs} review jobs, ${summary.memoryCandidates} pending candidates.`,
  );
  const report = yield* runSimulation();
  yield* Console.log(formatSimulationReport(report));
  return simulationExitCode(report);
});

const args = parseArgs(process.argv.slice(2));

const runnable = (
  args.help
    ? Console.log(USAGE).pipe(Effect.as(0))
    : program.pipe(
        Effect.provide(
          SimulationServices.pipe(
            Layer.provideMerge(
              args.dbPath === undefined
                ? SqlitePersistenceMemory
                : makeSqlitePersistenceLive(args.dbPath),
            ),
          ),
        ),
      )
).pipe(
  Effect.provide(DeterministicSeedRuntime(SEED_NOW).pipe(Layer.provideMerge(NodeServices.layer))),
);

Effect.runPromise(runnable).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`nomior:simulate failed: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
