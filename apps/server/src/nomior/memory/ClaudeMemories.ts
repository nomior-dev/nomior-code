/**
 * ClaudeMemories — import the memory notes Claude Code already keeps.
 *
 * Claude Code writes one fact per markdown file under
 * `<config dir>/projects/<slugged workspace root>/memory/`, with YAML
 * frontmatter carrying `name`, `description` and `metadata.type`. That is a
 * per-project memory the user has already curated, so Nomior reads it instead
 * of asking them to write it twice. Nothing is ever written back: this
 * direction is one-way.
 *
 * **Accounts.** One machine commonly has several Claude config dirs — the CLI
 * takes `CLAUDE_CONFIG_DIR`, and T3 exports it per provider instance, which is
 * how one user runs several subscriptions. Every `~/.claude*` directory with a
 * `projects/` inside is one such account, and they are read together: a note
 * is keyed by its frontmatter `name`, so the same fact written under two
 * accounts is one memory, the newest copy winning.
 *
 * **Freshness.** Each imported source records the file's mtime, so a sync
 * re-ingests only what changed and deletes what the user removed. That makes
 * `syncProject` cheap enough to run on the read path, which is what keeps the
 * import automatic — there is no daemon.
 *
 * @module nomior/memory/ClaudeMemories
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { SourceInput } from "../context/Model.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The index Claude Code loads every session. It is a table of contents over
 * the notes themselves, so importing it would duplicate all of them.
 */
const INDEX_FILE = "MEMORY.md";

/**
 * How Claude Code names a project's directory: every character outside
 * `[A-Za-z0-9]` becomes a dash. Paths past its length cap get a hash appended,
 * which is not reproducible from here — such a project imports nothing rather
 * than risk reading a neighbour's directory.
 */
export const claudeProjectSlug = (workspaceRoot: string): string =>
  workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The config directories to read, when the host must not be scanned for them.
 * Null — the default — means discover them (`discoverClaudeConfigRoots`), which
 * is why it is read per sync: an account added today needs no restart. Tests
 * set this to a temporary directory; a deployment can set it to `[]`.
 */
export const ClaudeConfigRoots = Context.Reference<ReadonlyArray<string> | null>(
  "t3/nomior/memory/ClaudeConfigRoots",
  { defaultValue: (): ReadonlyArray<string> | null => null },
);

const CLAUDE_CONFIG_DIR_PATTERN = /^\.claude(-.+)?$/;

/**
 * `~/.claude`, `~/.claude-work`, and any sibling an account was pointed at,
 * plus whatever `CLAUDE_CONFIG_DIR` names. Best-effort: a home directory that
 * cannot be listed means no imported memories, not a failed server.
 */
export const discoverClaudeConfigRoots = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
): Effect.Effect<ReadonlyArray<string>> =>
  fs.readDirectory(home).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((entries) => {
      const configured = process.env["CLAUDE_CONFIG_DIR"]?.trim() ?? "";
      return [
        ...new Set([
          ...(configured.length > 0 ? [path.resolve(expandHomePath(configured))] : []),
          ...entries
            .filter((entry) => CLAUDE_CONFIG_DIR_PATTERN.test(entry))
            .sort()
            .map((entry) => path.join(home, entry)),
        ]),
      ];
    }),
  );

interface ClaudeMemoryNote {
  /** Frontmatter `name`, the identity a fact keeps across accounts. */
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly type: string | null;
}

/** What one sync did, for the log line and the tests. */
export interface ClaudeMemorySyncReport {
  readonly imported: number;
  readonly removed: number;
  readonly unchanged: number;
}

const EMPTY_REPORT: ClaudeMemorySyncReport = { imported: 0, removed: 0, unchanged: 0 };

const readString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

/**
 * A note's frontmatter and body. Returns null for a file with no frontmatter
 * or no body — Claude Code writes both, so a file missing either is something
 * else that happens to live in the directory.
 */
export const parseClaudeMemory = (
  contents: string,
): {
  readonly name: string | null;
  readonly description: string | null;
  readonly type: string | null;
  readonly body: string;
} | null => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) return null;
  const body = contents.slice(match[0].length).trim();
  if (body.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const metadata = record["metadata"];
  const type =
    typeof metadata === "object" && metadata !== null
      ? readString(metadata as Record<string, unknown>, "type")
      : null;
  return {
    name: readString(record, "name"),
    description: readString(record, "description"),
    type,
    body,
  };
};

export interface ClaudeMemoriesShape {
  /**
   * Bring this project's imported memories level with what Claude Code has on
   * disk. Never fails: a memory import must not be able to break a search.
   */
  readonly syncProject: (project: {
    readonly projectId: string;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ClaudeMemorySyncReport>;
}

export class ClaudeMemories extends Context.Service<ClaudeMemories, ClaudeMemoriesShape>()(
  "t3/nomior/memory/ClaudeMemories",
) {}

/** `claude-memory:<project>:<note name>` — stable across accounts and renames of the file. */
const externalIdFor = (projectId: string, key: string): string =>
  `claude-memory:${projectId}:${key}`;

const toSourceInput = (projectId: string, note: ClaudeMemoryNote): SourceInput => ({
  kind: "memory",
  externalId: externalIdFor(projectId, note.key),
  title: note.title,
  provenance: {
    memorySource: "claude",
    memoryKey: note.key,
    path: note.path,
    mtimeMs: note.mtimeMs,
    ...(note.type === null ? {} : { memoryType: note.type }),
  },
  scopes: [{ kind: "project", value: projectId }],
  segments: [{ text: note.text }],
});

interface ImportedRow {
  readonly id: string;
  readonly externalId: string;
  readonly mtimeMs: number | null;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const ingest = yield* ContextIngest;

  /**
   * Every note this project has across accounts, newest copy per name. Reading
   * is best-effort per file: one unreadable note must not cost the others.
   */
  const readNotes = Effect.fn("ClaudeMemories.readNotes")(function* (workspaceRoot: string) {
    const configured = yield* ClaudeConfigRoots;
    const roots = configured ?? (yield* discoverClaudeConfigRoots(fs, path, NodeOS.homedir()));
    const slug = claudeProjectSlug(workspaceRoot);
    const byKey = new Map<string, ClaudeMemoryNote>();
    for (const root of roots) {
      const directory = path.join(root, "projects", slug, "memory");
      const entries = yield* fs
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries) {
        if (!entry.endsWith(".md") || entry === INDEX_FILE) continue;
        const file = path.join(directory, entry);
        const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
        const contents = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
        if (info === null || contents === null) continue;
        const parsed = parseClaudeMemory(contents);
        if (parsed === null) continue;

        const key = parsed.name ?? entry.slice(0, -3);
        const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() });
        const existing = byKey.get(key);
        if (existing !== undefined && existing.mtimeMs >= mtimeMs) continue;
        byKey.set(key, {
          key,
          title: parsed.description ?? key,
          text: parsed.body,
          path: file,
          mtimeMs,
          type: parsed.type,
        });
      }
    }
    return byKey;
  });

  const syncProject: ClaudeMemoriesShape["syncProject"] = Effect.fn("ClaudeMemories.syncProject")(
    function* (project) {
      const notes = yield* readNotes(project.workspaceRoot);
      const prefix = `${externalIdFor(project.projectId, "")}%`;
      const rows = yield* sql<ImportedRow>`
        SELECT
          id AS "id",
          external_id AS "externalId",
          json_extract(provenance_json, '$.mtimeMs') AS "mtimeMs"
        FROM nomior_sources
        WHERE kind = 'memory' AND external_id LIKE ${prefix}
      `;
      const imported = new Map(rows.map((row) => [row.externalId, row]));

      let importedCount = 0;
      let unchanged = 0;
      for (const note of notes.values()) {
        const previous = imported.get(externalIdFor(project.projectId, note.key));
        if (previous !== undefined && previous.mtimeMs === note.mtimeMs) {
          unchanged += 1;
          continue;
        }
        yield* ingest.ingestSource(toSourceInput(project.projectId, note));
        importedCount += 1;
      }

      // A note the user deleted must leave, or a retracted fact keeps
      // answering searches forever.
      const live = new Set([...notes.keys()].map((key) => externalIdFor(project.projectId, key)));
      const stale = rows.filter((row) => !live.has(row.externalId));
      for (const row of stale) {
        yield* sql`DELETE FROM nomior_sources WHERE id = ${row.id}`;
      }

      return { imported: importedCount, removed: stale.length, unchanged };
    },
    // Best effort by contract: the caller is a search, and a broken import is
    // a worse answer than a stale one.
    Effect.catchCause((cause) =>
      Effect.logWarning("nomior: Claude memory import failed", cause).pipe(Effect.as(EMPTY_REPORT)),
    ),
  );

  return ClaudeMemories.of({ syncProject });
});

export const ClaudeMemoriesLive = Layer.effect(ClaudeMemories, make);

/** For a deployment that must not read the user's Claude config at all. */
export const ClaudeMemoriesDisabled = Layer.succeed(
  ClaudeMemories,
  ClaudeMemories.of({ syncProject: () => Effect.succeed(EMPTY_REPORT) }),
);
