/**
 * The Claude memory import against real files on disk.
 *
 * A fake filesystem would only prove the parser reads what the writer wrote.
 * The behaviours worth pinning — a note that changed is re-read, a note that
 * did not is skipped, a deleted note leaves, and the same fact under two
 * accounts is one memory — are all about mtimes and directory layout, so this
 * writes actual files into a temporary home.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ContextBrokerLive } from "../context/ContextBroker.ts";
import {
  ClaudeConfigRoots,
  ClaudeMemories,
  ClaudeMemoriesLive,
  claudeProjectSlug,
  parseClaudeMemory,
} from "./ClaudeMemories.ts";

const WORKSPACE_ROOT = "/Users/dev/Projects/nomior-code";
const PROJECT = { projectId: "proj-1", workspaceRoot: WORKSPACE_ROOT };

const note = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

/**
 * A config root laid out the way Claude Code lays one out, under a temporary
 * directory that lives as long as the test.
 */
const makeRoot = Effect.fn("test.makeRoot")(function* (label: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: `claude-memories-${label}-` });
  const memory = path.join(base, "projects", claudeProjectSlug(WORKSPACE_ROOT), "memory");
  yield* fs.makeDirectory(memory, { recursive: true });
  return { base, memory };
});

const write = (file: string, contents: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(file, contents));

/** A fixed instant, so a test's mtimes never depend on when it ran. */
const EPOCH_SECONDS = 1_700_000_000;

/** `mtime` has whole-second resolution on some filesystems; move it decisively. */
const touch = (file: string, secondsFromEpoch: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.utimes(file, EPOCH_SECONDS + secondsFromEpoch, EPOCH_SECONDS + secondsFromEpoch),
  );

/** Only the roots the test made: never the developer's own Claude config. */
const sync = (roots: ReadonlyArray<string>) =>
  Effect.flatMap(ClaudeMemories, (memories) => memories.syncProject(PROJECT)).pipe(
    Effect.provideService(ClaudeConfigRoots, roots),
  );

const importedTitles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly title: string }>`
    SELECT title AS "title" FROM nomior_sources
    WHERE kind = 'memory' AND external_id LIKE 'claude-memory:proj-1:%'
    ORDER BY title ASC
  `;
  return rows.map((row) => row.title);
});

const layer = it.layer(
  ClaudeMemoriesLive.pipe(
    Layer.provideMerge(ContextBrokerLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

describe("parseClaudeMemory", () => {
  it("reads the frontmatter and the body", () => {
    const parsed = parseClaudeMemory(note("ports-are-derived", "Dev ports", "Ports derive."));
    assert.strictEqual(parsed?.name, "ports-are-derived");
    assert.strictEqual(parsed?.description, "Dev ports");
    assert.strictEqual(parsed?.type, "project");
    assert.strictEqual(parsed?.body, "Ports derive.");
  });

  it("skips a file with no frontmatter, and one with no body", () => {
    assert.isNull(parseClaudeMemory("# Just a heading\n"));
    assert.isNull(parseClaudeMemory("---\nname: empty\n---\n\n"));
  });
});

layer("ClaudeMemories", (it) => {
  it.effect("imports a project's notes, skipping the index Claude reads itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeRoot("one");
        yield* write(
          path.join(root.memory, "ports.md"),
          note("ports", "Dev ports", "Ports derive."),
        );
        yield* write(path.join(root.memory, "MEMORY.md"), "- [Dev ports](ports.md) — hook\n");

        const report = yield* sync([root.base]);

        assert.strictEqual(report.imported, 1);
        assert.deepStrictEqual(yield* importedTitles, ["Dev ports"]);
      }),
    ),
  );

  it.effect("re-reads only what changed, and drops what the user deleted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRoot("two");
        const kept = path.join(root.memory, "ports.md");
        const removed = path.join(root.memory, "stale.md");
        yield* write(kept, note("ports", "Dev ports", "Ports derive."));
        yield* write(removed, note("stale", "Old fact", "No longer true."));

        yield* sync([root.base]);
        const unchanged = yield* sync([root.base]);
        assert.deepStrictEqual(unchanged, { imported: 0, unchanged: 2, removed: 0 });

        yield* write(kept, note("ports", "Dev ports", "Ports derive from the worktree path."));
        yield* touch(kept, 60);
        yield* fs.remove(removed);
        const after = yield* sync([root.base]);

        assert.strictEqual(after.imported, 1);
        assert.strictEqual(after.removed, 1);
        assert.deepStrictEqual(yield* importedTitles, ["Dev ports"]);
      }),
    ),
  );

  it.effect("merges accounts: one fact written under two config roots is one memory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const older = yield* makeRoot("personal");
        const newer = yield* makeRoot("work");
        const stale = path.join(older.memory, "ports.md");
        const fresh = path.join(newer.memory, "ports.md");
        yield* write(stale, note("ports", "Dev ports", "The older account's copy."));
        yield* write(fresh, note("ports", "Dev ports", "The newer account's copy."));
        yield* touch(stale, -600);
        yield* touch(fresh, 600);

        const report = yield* sync([older.base, newer.base]);
        assert.strictEqual(report.imported, 1);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly text: string }>`
        SELECT c.text AS "text" FROM nomior_chunks c
        JOIN nomior_sources s ON s.id = c.source_id
        WHERE s.kind = 'memory' AND c.ordinal = 0
      `;
        assert.deepStrictEqual(
          rows.map((row) => row.text),
          ["The newer account's copy."],
        );
      }),
    ),
  );
});
