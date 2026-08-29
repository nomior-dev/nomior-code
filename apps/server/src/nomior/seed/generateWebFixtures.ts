// @effect-diagnostics nodeBuiltinImport:off - build-time codegen CLI.
/**
 * generateWebFixtures - write the web panels' generated fixture module.
 *
 * `pnpm nomior:gen-fixtures` regenerates
 * `apps/web/src/nomior/fixtures.generated.ts` from the seed scenario;
 * `--check` verifies the committed file matches (what CI would run) without
 * writing. `webFixtures.test.ts` asserts the same thing, so a scenario change
 * that forgets the regeneration fails the suite rather than shipping two
 * versions of the demo data.
 *
 * @module nomior/seed/generateWebFixtures
 */
import * as NodeFS from "node:fs";

import { renderWebFixturesModule, webFixturesPath } from "./webFixtures.ts";

const target = webFixturesPath();
const rendered = renderWebFixturesModule();

if (process.argv.includes("--check")) {
  const current = NodeFS.readFileSync(target, "utf8");
  if (current === rendered) {
    process.stdout.write(`${target} is up to date.\n`);
  } else {
    process.stderr.write(`${target} is stale. Run: pnpm --filter t3 nomior:gen-fixtures\n`);
    process.exitCode = 1;
  }
} else {
  NodeFS.writeFileSync(target, rendered, "utf8");
  process.stdout.write(`Wrote ${target}\n`);
}
