import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  compareAgainstManifest,
  listChangedFiles,
  parseForkManifest,
  parseNameStatusZ,
  selectUpstreamOwnedChanges,
} from "./check-fork-manifest.ts";

const encoder = new TextEncoder();

function mockHandle(options: { readonly exitCode: number; readonly stdout?: string }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(options.stdout ?? "")),
    stderr: Stream.make(encoder.encode("")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const MANIFEST_FIXTURE = `# Fork manifest

Prose before the table, including a decoy | pipe row.

<!-- fork-manifest:begin -->
| Path | Reason |
| --- | --- |
| \`package.json\` | root script registration |
| \`apps/web/src/branding.ts\` | branding fallback |
| \`pnpm-lock.yaml\` | lockfile policy |
<!-- fork-manifest:end -->

Prose after the table.
`;

describe("parseForkManifest", () => {
  it.effect("parses table rows into path/reason entries", () =>
    Effect.gen(function* () {
      const entries = yield* parseForkManifest(MANIFEST_FIXTURE, "docs/nomior/FORK-MANIFEST.md");

      assert.deepEqual(
        entries.map((entry) => entry.path),
        ["package.json", "apps/web/src/branding.ts", "pnpm-lock.yaml"],
      );
      assert.equal(entries[0]?.reason, "root script registration");
    }),
  );

  it.effect("fails when the markers are missing", () =>
    Effect.gen(function* () {
      const error = yield* parseForkManifest("# no markers here", "manifest.md").pipe(Effect.flip);

      assert.equal(error._tag, "ForkManifestParseError");
      assert.include(error.reason, "markers");
    }),
  );

  it.effect("fails when the markers hold no table", () =>
    Effect.gen(function* () {
      const error = yield* parseForkManifest(
        "<!-- fork-manifest:begin -->\nprose only\n<!-- fork-manifest:end -->",
        "manifest.md",
      ).pipe(Effect.flip);

      assert.equal(error._tag, "ForkManifestParseError");
      assert.include(error.reason, "no manifest table");
    }),
  );

  it.effect("fails on duplicate paths", () =>
    Effect.gen(function* () {
      const fixture = [
        "<!-- fork-manifest:begin -->",
        "| Path | Reason |",
        "| --- | --- |",
        "| `package.json` | one |",
        "| `package.json` | two |",
        "<!-- fork-manifest:end -->",
      ].join("\n");
      const error = yield* parseForkManifest(fixture, "manifest.md").pipe(Effect.flip);

      assert.equal(error._tag, "ForkManifestParseError");
      assert.include(error.reason, "duplicate path: package.json");
    }),
  );

  it.effect("fails on a row with an empty path", () =>
    Effect.gen(function* () {
      const fixture = [
        "<!-- fork-manifest:begin -->",
        "| Path | Reason |",
        "| --- | --- |",
        "| | missing |",
        "<!-- fork-manifest:end -->",
      ].join("\n");
      const error = yield* parseForkManifest(fixture, "manifest.md").pipe(Effect.flip);

      assert.equal(error._tag, "ForkManifestParseError");
      assert.include(error.reason, "empty path");
    }),
  );
});

describe("parseNameStatusZ", () => {
  it("parses NUL-separated status/path pairs", () => {
    const raw = "M\0package.json\0A\0packages/nomior-context/src/index.ts\0D\0docs/old.md\0";

    assert.deepEqual(parseNameStatusZ(raw), [
      { status: "M", path: "package.json" },
      { status: "A", path: "packages/nomior-context/src/index.ts" },
      { status: "D", path: "docs/old.md" },
    ]);
  });

  it("returns no changes for empty output", () => {
    assert.deepEqual(parseNameStatusZ(""), []);
  });
});

describe("selectUpstreamOwnedChanges", () => {
  it("keeps modifications, deletions, and type changes but drops additions", () => {
    const changed = selectUpstreamOwnedChanges([
      { status: "M", path: "package.json" },
      { status: "A", path: "docs/nomior/FORK-MANIFEST.md" },
      { status: "D", path: "docs/removed.md" },
      { status: "T", path: "scripts/tool" },
    ]);

    assert.deepEqual(changed, ["docs/removed.md", "package.json", "scripts/tool"]);
  });
});

describe("compareAgainstManifest", () => {
  it("splits changes into undeclared, declared, and stale", () => {
    const comparison = compareAgainstManifest({
      changedUpstreamPaths: ["package.json", "apps/web/src/branding.ts", "apps/server/src/bin.ts"],
      declaredPaths: ["package.json", "apps/web/src/branding.ts", "pnpm-lock.yaml"],
    });

    assert.deepEqual(comparison.undeclared, ["apps/server/src/bin.ts"]);
    assert.deepEqual(comparison.declaredChanged, ["apps/web/src/branding.ts", "package.json"]);
    assert.deepEqual(comparison.stale, ["pnpm-lock.yaml"]);
  });

  it("reports a clean tree as fully stale declarations", () => {
    const comparison = compareAgainstManifest({
      changedUpstreamPaths: [],
      declaredPaths: ["package.json"],
    });

    assert.deepEqual(comparison.undeclared, []);
    assert.deepEqual(comparison.declaredChanged, []);
    assert.deepEqual(comparison.stale, ["package.json"]);
  });
});

describe("listChangedFiles", () => {
  it.effect("parses git diff output from the spawned process", () =>
    Effect.gen(function* () {
      const changes = yield* listChangedFiles("abc123", "/repo").pipe(
        Effect.scoped,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(mockHandle({ exitCode: 0, stdout: "M\0package.json\0A\0new.ts\0" })),
          ),
        ),
      );

      assert.deepEqual(changes, [
        { status: "M", path: "package.json" },
        { status: "A", path: "new.ts" },
      ]);
    }),
  );

  it.effect("surfaces a git failure with its exit code and stderr", () =>
    Effect.gen(function* () {
      const error = yield* listChangedFiles("abc123", "/repo").pipe(
        Effect.scoped,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockHandle({ exitCode: 128 }))),
        ),
        Effect.flip,
      );

      if (error._tag !== "ForkManifestGitExitError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.exitCode, 128);
      assert.equal(error.executable, "git");
      assert.equal(error.cwd, "/repo");
    }),
  );
});
