#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as String from "effect/String";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

const MANIFEST_BEGIN_MARKER = "<!-- fork-manifest:begin -->";
const MANIFEST_END_MARKER = "<!-- fork-manifest:end -->";
const DEFAULT_MANIFEST_PATH = "docs/nomior/FORK-MANIFEST.md";
const DEFAULT_UPSTREAM_REF = "upstream/main";

export interface ForkManifestEntry {
  readonly path: string;
  readonly reason: string;
}

export class ForkManifestParseError extends Schema.TaggedErrorClass<ForkManifestParseError>()(
  "ForkManifestParseError",
  {
    manifestPath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Could not parse fork manifest at ${this.manifestPath}: ${this.reason}`;
  }
}

export class ForkManifestReadError extends Schema.TaggedErrorClass<ForkManifestReadError>()(
  "ForkManifestReadError",
  {
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read fork manifest at ${this.manifestPath}.`;
  }
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const gitProcessContext = {
  executable: Schema.Literal("git"),
  argumentCount: NonNegativeInt,
  cwd: Schema.String,
};

export class ForkManifestGitProcessError extends Schema.TaggedErrorClass<ForkManifestGitProcessError>()(
  "ForkManifestGitProcessError",
  {
    ...gitProcessContext,
    operation: Schema.Literals(["spawn", "read-stdout", "read-stderr", "wait-for-exit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to run git during process operation "${this.operation}".`;
  }
}

export class ForkManifestGitExitError extends Schema.TaggedErrorClass<ForkManifestGitExitError>()(
  "ForkManifestGitExitError",
  {
    ...gitProcessContext,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    return `git exited with code ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

export class UndeclaredUpstreamModificationError extends Schema.TaggedErrorClass<UndeclaredUpstreamModificationError>()(
  "UndeclaredUpstreamModificationError",
  {
    paths: Schema.Array(Schema.String),
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.paths.length} upstream-owned file(s) modified without a fork-manifest entry. ` +
      `Declare each in ${this.manifestPath} or move the change into an additive module.`
    );
  }
}

/**
 * Parses the manifest table between the fork-manifest markers. Rows carry the
 * repo-relative path (backticks stripped) and the reason; the header and
 * separator rows are skipped. Duplicate paths are an error so stale rows
 * cannot mask each other.
 */
export function parseForkManifest(
  markdown: string,
  manifestPath: string,
): Effect.Effect<ReadonlyArray<ForkManifestEntry>, ForkManifestParseError> {
  return Effect.gen(function* () {
    const beginIndex = markdown.indexOf(MANIFEST_BEGIN_MARKER);
    const endIndex = markdown.indexOf(MANIFEST_END_MARKER);
    if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
      return yield* new ForkManifestParseError({
        manifestPath,
        reason: `missing ${MANIFEST_BEGIN_MARKER} / ${MANIFEST_END_MARKER} markers`,
      });
    }

    const tableRows = markdown
      .slice(beginIndex + MANIFEST_BEGIN_MARKER.length, endIndex)
      .split(/\r?\n/)
      .map(String.trim)
      .filter((line) => line.startsWith("|"));

    if (tableRows.length < 2) {
      return yield* new ForkManifestParseError({
        manifestPath,
        reason: "no manifest table between the markers",
      });
    }

    const entries: Array<ForkManifestEntry> = [];
    const seen = new Set<string>();
    // Row 0 is the header, row 1 the separator.
    for (const row of tableRows.slice(2)) {
      const cells = row
        .split("|")
        .map(String.trim)
        .filter((_, index, all) => index > 0 && index < all.length - 1);
      const rawPath = cells[0] ?? "";
      const path = rawPath.replaceAll("`", "").trim();
      const reason = cells[1] ?? "";
      if (path.length === 0) {
        return yield* new ForkManifestParseError({
          manifestPath,
          reason: `row with an empty path: ${row}`,
        });
      }
      if (seen.has(path)) {
        return yield* new ForkManifestParseError({
          manifestPath,
          reason: `duplicate path: ${path}`,
        });
      }
      seen.add(path);
      entries.push({ path, reason });
    }

    return entries;
  });
}

export interface GitFileChange {
  readonly status: string;
  readonly path: string;
}

/**
 * Parses `git diff --name-status --no-renames -z` output: a flat sequence of
 * NUL-separated status/path pairs. `--no-renames` guarantees exactly one path
 * per record (renames arrive as separate D and A entries).
 */
export function parseNameStatusZ(raw: string): ReadonlyArray<GitFileChange> {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const changes: Array<GitFileChange> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (status === undefined || path === undefined) continue;
    changes.push({ status, path });
  }
  return changes;
}

/**
 * Upstream-owned modifications are diff entries whose path existed in the
 * merge-base tree: modified (M), deleted (D), or type-changed (T). Added (A)
 * entries are the fork's additive files and never budget against the
 * manifest.
 */
export function selectUpstreamOwnedChanges(
  changes: ReadonlyArray<GitFileChange>,
): ReadonlyArray<string> {
  return changes
    .filter((change) => change.status !== "A")
    .map((change) => change.path)
    .toSorted();
}

export interface ForkManifestComparison {
  readonly undeclared: ReadonlyArray<string>;
  readonly declaredChanged: ReadonlyArray<string>;
  readonly stale: ReadonlyArray<string>;
}

export function compareAgainstManifest(input: {
  readonly changedUpstreamPaths: ReadonlyArray<string>;
  readonly declaredPaths: ReadonlyArray<string>;
}): ForkManifestComparison {
  const declared = new Set(input.declaredPaths);
  const changed = new Set(input.changedUpstreamPaths);
  return {
    undeclared: input.changedUpstreamPaths.filter((path) => !declared.has(path)).toSorted(),
    declaredChanged: input.changedUpstreamPaths.filter((path) => declared.has(path)).toSorted(),
    stale: input.declaredPaths.filter((path) => !changed.has(path)).toSorted(),
  };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

export const runGit = Effect.fn("runGit")(function* (
  args: ReadonlyArray<string>,
  cwd = process.cwd(),
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = {
    executable: "git",
    argumentCount: args.length,
    cwd,
  } as const;
  const child = yield* spawner
    .spawn(ChildProcess.make("git", args, { cwd }))
    .pipe(
      Effect.mapError(
        (cause) => new ForkManifestGitProcessError({ ...context, operation: "spawn", cause }),
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new ForkManifestGitProcessError({ ...context, operation: "read-stdout", cause }),
        ),
      ),
      collectStreamAsString(child.stderr).pipe(
        Effect.mapError(
          (cause) =>
            new ForkManifestGitProcessError({ ...context, operation: "read-stderr", cause }),
        ),
      ),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(
          (cause) =>
            new ForkManifestGitProcessError({ ...context, operation: "wait-for-exit", cause }),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new ForkManifestGitExitError({ ...context, exitCode, stderr });
  }

  return stdout;
});

export const resolveMergeBase = Effect.fn("resolveMergeBase")(function* (
  upstreamRef: string,
  cwd?: string,
) {
  const stdout = yield* runGit(["merge-base", "HEAD", upstreamRef], cwd);
  return stdout.trim();
});

export const listChangedFiles = Effect.fn("listChangedFiles")(function* (
  base: string,
  cwd?: string,
) {
  const stdout = yield* runGit(["diff", "--name-status", "--no-renames", "-z", base, "HEAD"], cwd);
  return parseNameStatusZ(stdout);
});

const readManifestEntries = Effect.fn("readManifestEntries")(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const markdown = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError((cause) => new ForkManifestReadError({ manifestPath, cause })));
  return yield* parseForkManifest(markdown, manifestPath);
});

const formatPathList = (paths: ReadonlyArray<string>): string =>
  paths.map((path) => `  - ${path}`).join("\n");

const ForkManifestJsonReport = Schema.Struct({
  base: Schema.String,
  undeclared: Schema.Array(Schema.String),
  declaredChanged: Schema.Array(Schema.String),
  stale: Schema.Array(Schema.String),
});
const encodeJsonReport = Schema.encodeEffect(fromJsonStringPretty(ForkManifestJsonReport));

const checkForkManifest = Effect.fn("checkForkManifest")(function* (input: {
  readonly manifestPath: string;
  readonly upstreamRef: string;
  readonly baseOverride: string | undefined;
  readonly json: boolean;
}) {
  const entries = yield* readManifestEntries(input.manifestPath);
  const base = input.baseOverride ?? (yield* resolveMergeBase(input.upstreamRef));
  const changes = yield* listChangedFiles(base);
  const comparison = compareAgainstManifest({
    changedUpstreamPaths: selectUpstreamOwnedChanges(changes),
    declaredPaths: entries.map((entry) => entry.path),
  });

  if (input.json) {
    yield* Console.log(yield* encodeJsonReport({ base, ...comparison }));
  } else {
    yield* Console.log(`Fork manifest check against merge-base ${base}`);
    yield* Console.log(
      `Declared upstream modifications touched: ${comparison.declaredChanged.length}` +
        (comparison.declaredChanged.length > 0
          ? `\n${formatPathList(comparison.declaredChanged)}`
          : ""),
    );
    if (comparison.stale.length > 0) {
      yield* Console.log(
        `Declared but unchanged against this merge-base (stale or pending entries):\n${formatPathList(comparison.stale)}`,
      );
    }
    if (comparison.undeclared.length > 0) {
      yield* Console.log(
        `UNDECLARED upstream modifications:\n${formatPathList(comparison.undeclared)}`,
      );
    }
  }

  if (comparison.undeclared.length > 0) {
    return yield* new UndeclaredUpstreamModificationError({
      paths: comparison.undeclared,
      manifestPath: input.manifestPath,
    });
  }
});

const command = Command.make(
  "check-fork-manifest",
  {
    manifest: Flag.string("manifest").pipe(
      Flag.withDescription("Path to the fork manifest markdown file."),
      Flag.withDefault(DEFAULT_MANIFEST_PATH),
    ),
    upstreamRef: Flag.string("upstream-ref").pipe(
      Flag.withDescription("Upstream ref used to compute the merge-base with HEAD."),
      Flag.withDefault(DEFAULT_UPSTREAM_REF),
    ),
    base: Flag.string("base").pipe(
      Flag.withDescription("Explicit merge-base commit; skips upstream-ref resolution."),
      Flag.optional,
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Emit a machine-readable JSON report instead of prose."),
      Flag.withDefault(false),
    ),
    printManifestPaths: Flag.boolean("print-manifest-paths").pipe(
      Flag.withDescription("Print declared manifest paths, one per line, and exit."),
      Flag.withDefault(false),
    ),
  },
  ({ base, json, manifest, printManifestPaths, upstreamRef }) =>
    printManifestPaths
      ? readManifestEntries(manifest).pipe(
          Effect.flatMap((entries) => Console.log(entries.map((entry) => entry.path).join("\n"))),
        )
      : checkForkManifest({
          manifestPath: manifest,
          upstreamRef,
          baseOverride: Option.getOrUndefined(base),
          json,
        }),
).pipe(
  Command.withDescription(
    "Fails when an upstream-owned file differs from the upstream merge-base without a fork-manifest entry.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
