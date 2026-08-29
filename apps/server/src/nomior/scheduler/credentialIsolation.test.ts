/**
 * Structural guard for the provider-account policy (PLAN.md): scheduler
 * signals are credential-free by construction, and the review engine talks
 * to providers only through the `LegRunner` port. These tests fail if anyone
 * wires a nomior module to credential storage, provider homes, or
 * usage-endpoint polling.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Every nomior source directory, relative to this file. */
const SWEPT_DIRS = [".", "../review", "../persistence", "../persistence/Migrations"];

const listModuleSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources = new Map<string, string>();
  for (const dir of SWEPT_DIRS) {
    const absolute = path.join(import.meta.dirname, dir);
    for (const entry of yield* fs.readDirectory(absolute)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      sources.set(path.join(dir, entry), yield* fs.readFileString(path.join(absolute, entry)));
    }
  }
  return sources;
});

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

/**
 * Everything a nomior module may import. Additions here deserve review: this
 * code must stay credential-free, so no auth modules, no provider home
 * layouts, no usage scanners, no keychain bindings, no network clients.
 */
const ALLOWED_IMPORT_PATTERNS: ReadonlyArray<RegExp> = [
  /^effect\/[A-Za-z/]+$/,
  /^effect\/unstable\/sql\/[A-Za-z]+$/,
  /^@t3tools\/contracts$/,
  /^\.\/[A-Za-z]+\.ts$/,
  /^\.\/Migrations\/\d{3}_[A-Za-z]+\.ts$/,
  /^\.\.\/persistence\/[A-Za-z]+\.ts$/,
  /^\.\.\/\.\.\/persistence\/Errors\.ts$/,
  /^\.\.\/\.\.\/persistence\/Layers\/Sqlite\.ts$/,
  /^\.\.\/\.\.\/provider\/Services\/ProviderService\.ts$/,
];

/** Identifiers that would indicate credential or usage-endpoint access. */
const FORBIDDEN_CODE_PATTERNS: ReadonlyArray<RegExp> = [
  /keytar/i,
  /keychain/i,
  /readSecret|SecretStore|cliAuth/,
  /CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME/,
  /homePath|ClaudeHome|CodexHomeLayout/,
  /getUsageSummary|usageScan/i,
  /HttpClient|fetch\s*\(/,
  /child_process|processRunner|spawn\s*\(/,
];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("nomior credential isolation", () => {
  it.effect("imports nothing credential-related", () =>
    Effect.gen(function* () {
      const sources = yield* listModuleSources;
      assert.isAbove(sources.size, 0, "nomior modules must exist");

      for (const [file, source] of sources) {
        for (const specifier of importSpecifiers(source)) {
          assert.isTrue(
            ALLOWED_IMPORT_PATTERNS.some((pattern) => pattern.test(specifier)),
            `${file} imports "${specifier}", which is outside the credential-free allowlist`,
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("contains no credential, provider-home, or usage-endpoint access", () =>
    Effect.gen(function* () {
      const sources = yield* listModuleSources;

      for (const [file, source] of sources) {
        const code = stripComments(source);
        for (const pattern of FORBIDDEN_CODE_PATTERNS) {
          assert.isFalse(
            pattern.test(code),
            `${file} matches forbidden pattern ${pattern}: nomior modules must stay credential-free`,
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("has no way to address an existing thread", () =>
    Effect.gen(function* () {
      const sources = yield* listModuleSources;
      const scheduler = sources.get("InstanceScheduler.ts");
      assert.isDefined(scheduler);
      // The scheduler never imports ThreadId: it cannot even name a thread,
      // let alone move one between instances.
      assert.notMatch(stripComments(scheduler ?? ""), /\bThreadId\b/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
