/**
 * Whole-tree structural guards for the fork's safety invariants
 * (`docs/nomior/WORKING-RULES.md` — "Safety invariants").
 *
 * `scheduler/credentialIsolation.test.ts` sweeps the scheduler, review and
 * persistence modules with a hard import allowlist; that allowlist cannot
 * cover the connectors, which legitimately talk to Google. This file sweeps
 * EVERY Nomior source instead, with the invariants that hold everywhere no
 * matter what a module is for:
 *
 * 1. no provider credential access (Claude/Codex/Grok homes, keychains,
 *    usage endpoints);
 * 2. no outbound host outside a reviewed allowlist;
 * 3. no writes into repo-controlled agent files, and no automatic caller for
 *    the one module that writes into a repo at all.
 *
 * These are cheap greps on purpose: they fail on the line that introduces the
 * problem, in the PR that introduces it, without needing the module wired up.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Every directory Nomior code lives in, relative to this file. */
const NOMIOR_ROOTS = [".", "../mcp/toolkits/nomior", "../../../web/src/nomior"];

interface SourceFile {
  readonly label: string;
  readonly source: string;
  readonly code: string;
  readonly isTest: boolean;
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const collect = Effect.fn("safetyInvariants.collect")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<SourceFile> = [];

  const walk = (absolute: string, label: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      for (const entry of yield* fs.readDirectory(absolute)) {
        const child = path.join(absolute, entry);
        const childLabel = `${label}/${entry}`;
        const info = yield* fs.stat(child);
        if (info.type === "Directory") {
          yield* walk(child, childLabel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const source = yield* fs.readFileString(child);
        files.push({
          label: childLabel,
          source,
          code: stripComments(source),
          isTest: /\.test\.tsx?$/.test(entry),
        });
      }
    }).pipe(Effect.orDie);

  yield* walk(path.join(import.meta.dirname, root), root);
  return files;
});

const allSources = Effect.gen(function* () {
  const collected = yield* Effect.forEach(NOMIOR_ROOTS, collect);
  const files = collected.flat();
  assert.isAbove(files.length, 50, "the sweep must actually find the Nomior tree");
  return files;
});

/**
 * Provider credentials are the ones the fork must never touch: multi-account
 * means local profiles the user signed into with the vendor's own CLI, and the
 * scheduler runs on rate-limit events those CLIs already emit. Google OAuth is
 * a different thing entirely — a source the user connects, whose tokens live
 * in upstream's secret store — so these patterns name provider credentials
 * specifically rather than banning the word "token".
 */
const PROVIDER_CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/keytar|keychain/i, "OS keychain access"],
  [/CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME/, "a provider home directory"],
  [/\.credentials\.json|claude\.json|auth\.json/, "a provider credential file"],
  [/getUsageSummary|usageScan|usagePoll/i, "usage-endpoint polling"],
  [/api\.anthropic\.com|chatgpt\.com|api\.openai\.com|console\.anthropic\.com/i, "a provider API"],
];

/**
 * Hosts Nomior source may name. Everything here is either a source the user
 * explicitly connects (Google) or our own marketing domain; nothing on this
 * list receives transcripts, mail or memories — the Google endpoints are read
 * scopes and the OAuth exchange.
 */
const ALLOWED_HOSTS: ReadonlyArray<string> = [
  "accounts.google.com",
  "www.googleapis.com",
  "oauth2.googleapis.com",
  "developers.google.com",
  "github.com",
  "code.nomior.com",
  "nomior.com",
  "127.0.0.1",
  "localhost",
];

describe("nomior safety invariants (whole tree)", () => {
  it.effect("no module reads provider credentials or polls usage endpoints", () =>
    Effect.gen(function* () {
      // Demo copy, not code: the seeded scenario contains a transcript in
      // which the team explains this very policy ("no keychain, no provider
      // home directories"), and the generated web fixtures echo it.
      const demoCopy = new Set([
        "./seed/scenario.ts",
        "../../../web/src/nomior/fixtures.generated.ts",
      ]);
      for (const file of yield* allSources) {
        if (file.isTest || demoCopy.has(file.label)) continue;
        for (const [pattern, what] of PROVIDER_CREDENTIAL_PATTERNS) {
          assert.notMatch(
            file.code,
            pattern,
            `${file.label} references ${what}; Nomior code must stay credential-free`,
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("every outbound host in Nomior source is on the reviewed allowlist", () =>
    Effect.gen(function* () {
      for (const file of yield* allSources) {
        if (file.isTest) continue;
        for (const match of file.code.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
          const host = match[1] ?? "";
          assert.include(
            ALLOWED_HOSTS,
            host,
            `${file.label} names host ${host}; every outbound destination needs an explicit review`,
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * Anything that could originate a request gets named here, so adding one is
   * a deliberate edit to this list rather than an unnoticed new data path.
   * `googleapisRuntime.ts` is the single seam onto the Google SDK; `GoogleAuth`
   * runs a loopback HTTP *server* for the OAuth redirect, which receives a
   * code on 127.0.0.1 and sends nothing anywhere.
   */
  it.effect("network clients live only in the declared connector seams", () =>
    Effect.gen(function* () {
      const allowed = new Set([
        "./connectors/google/googleapisRuntime.ts",
        "./connectors/google/GoogleAuth.ts",
      ]);
      for (const file of yield* allSources) {
        if (file.isTest) continue;
        const client =
          /\bfetch\s*\(/.test(file.code) ||
          /HttpClient/.test(file.code) ||
          /\bXMLHttpRequest\b|\bWebSocket\b|node:https?\b/.test(file.code);
        if (!client) continue;
        assert.isTrue(
          allowed.has(file.label),
          `${file.label} opens a network client outside the declared seams`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * Provider memory mirrors are explicit user-triggered exports. Nothing may
   * write a repo's agent files, and the only module that writes into a repo at
   * all writes one file it owns end to end, under its own directory.
   */
  it.effect("nothing writes repo-controlled agent files", () =>
    Effect.gen(function* () {
      const writesAllowed = new Set([
        // Writes `<root>/{.agents,.claude}/skills/nomior-context/SKILL.md`, a
        // path it owns whole; refuses to clobber a differing file.
        "./skills/SkillBundle.ts",
        // Build-time codegen CLI for the web panels' fixture module.
        "./seed/generateWebFixtures.ts",
      ]);
      for (const file of yield* allSources) {
        if (file.isTest) continue;
        assert.notMatch(
          file.code,
          /["'`][^"'`]*(?:CLAUDE\.md|AGENTS\.md)/,
          `${file.label} names a repo-controlled agent file`,
        );
        const writes = /writeFile|appendFile|makeDirectory|mkdir|createWriteStream/.test(file.code);
        if (!writes) continue;
        assert.isTrue(
          writesAllowed.has(file.label),
          `${file.label} writes to the filesystem outside the declared, user-triggered exports`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * The other half of "user-triggered": a module that only ever runs on a
   * user action must have no automatic caller. Nothing in the server wires
   * `SkillBundle` into a layer or a daemon, so materialization cannot happen
   * behind the user's back.
   */
  it.effect("SkillBundle has no caller: materialization is user-triggered only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSrc = path.join(import.meta.dirname, "..");

      const offenders: Array<string> = [];
      const walk = (absolute: string, label: string): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          for (const entry of yield* fs.readDirectory(absolute)) {
            const child = path.join(absolute, entry);
            const childLabel = `${label}/${entry}`;
            if ((yield* fs.stat(child)).type === "Directory") {
              yield* walk(child, childLabel);
              continue;
            }
            if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
            if (entry.startsWith("SkillBundle")) continue;
            if (/\bSkillBundle\b/.test(yield* fs.readFileString(child))) {
              offenders.push(childLabel);
            }
          }
        }).pipe(Effect.orDie);

      yield* walk(serverSrc, "src");
      assert.deepStrictEqual(
        offenders,
        [],
        "SkillBundle gained a caller; materialization must stay an explicit user action",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
