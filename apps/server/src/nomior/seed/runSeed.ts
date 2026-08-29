/**
 * runSeed - CLI entry for `pnpm nomior:seed [--db <path>] [--reset]`.
 *
 * Writes the demo scenario into a real database file so the panels, the MCP
 * toolkit and the review board have something true to render. Without `--db`
 * it targets the same `state.sqlite` the server uses (`T3CODE_HOME`, else
 * `~/.t3`), so `pnpm nomior:seed` followed by starting the app just works.
 *
 * @module nomior/seed/runSeed
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { deriveServerPaths } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { resolveBaseDir } from "../../os-jank.ts";
import { DeterministicSeedRuntime } from "./deterministic.ts";
import { SEED_NOW } from "./scenario.ts";
import { formatSeedSummary, NomiorSeedServices, seedNomior } from "./seed.ts";

const USAGE = `Usage: nomior:seed [--db <path>] [--reset]

  --db <path>   SQLite file to seed. Defaults to the server's own state.sqlite.
  --reset       Delete the rows a previous seed wrote before seeding again.
                Rows the seed did not write are never touched.
  --help        Print this.`;

export interface SeedCliArgs {
  readonly dbPath: string | undefined;
  readonly reset: boolean;
  readonly help: boolean;
}

/** Pure argv parsing so the flag handling is testable without a process. */
export const parseSeedArgs = (argv: ReadonlyArray<string>): SeedCliArgs => {
  let dbPath: string | undefined;
  let reset = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reset") {
      reset = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    }
  }
  return { dbPath, reset, help };
};

const defaultDbPath = Effect.fn("nomiorSeed.defaultDbPath")(function* () {
  const baseDir = yield* resolveBaseDir(process.env["T3CODE_HOME"]);
  const paths = yield* deriveServerPaths(baseDir, undefined, {});
  return paths.dbPath;
});

const program = Effect.gen(function* () {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    yield* Console.log(USAGE);
    return 0;
  }

  const path = yield* Path.Path;
  const dbPath = args.dbPath === undefined ? yield* defaultDbPath() : path.resolve(args.dbPath);
  yield* Console.log(`Seeding ${dbPath}`);

  const summary = yield* seedNomior({ reset: args.reset }).pipe(
    Effect.provide(NomiorSeedServices.pipe(Layer.provideMerge(makeSqlitePersistenceLive(dbPath)))),
  );
  yield* Console.log(formatSeedSummary(summary));
  return 0;
});

const runnable = program.pipe(
  Effect.provide(DeterministicSeedRuntime(SEED_NOW).pipe(Layer.provideMerge(NodeServices.layer))),
);

Effect.runPromise(runnable).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`nomior:seed failed: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
