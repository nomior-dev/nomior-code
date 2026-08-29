// @effect-diagnostics nodeBuiltinImport:off - fixture stores are built with raw node:sqlite/fs.
// @effect-diagnostics preferSchemaOverJson:off - fixtures serialize Anarlog's on-disk JSON verbatim.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ConnectorSchemaVersionError } from "../Errors.ts";
import { ConnectorAccountId } from "../Records.ts";
import { AnarlogDriver } from "./AnarlogDriver.ts";
import { ANARLOG_SCHEMA_VERSION_CEILING } from "./AnarlogSchema.ts";

const accountId = ConnectorAccountId.make("anarlog_local");

const decodeConfig = Schema.decodeUnknownSync(AnarlogDriver.configSchema);

interface FixtureOptions {
  readonly schemaVersion: bigint;
}

const createFixtureStore = (dir: string, options: FixtureOptions): string => {
  const storePath = NodePath.join(dir, "app.db");
  const db = new NodeSqlite.DatabaseSync(storePath);
  db.exec(`
    CREATE TABLE _sqlx_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      installed_on TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 1,
      checksum BLOB,
      execution_time INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      ended_at TEXT NOT NULL DEFAULT '',
      event_id TEXT NOT NULL DEFAULT '',
      external_event_id TEXT NOT NULL DEFAULT '',
      series_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      words_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE session_documents (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL DEFAULT '',
      body_format TEXT NOT NULL DEFAULT 'prosemirror_json',
      body TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE session_participants (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
  `);
  db.prepare("INSERT INTO _sqlx_migrations (version) VALUES (?)").run(options.schemaVersion);
  db.close();
  return storePath;
};

const seedMeeting = (storePath: string): void => {
  const db = new NodeSqlite.DatabaseSync(storePath);
  db.prepare(
    `INSERT INTO sessions (id, title, started_at, ended_at, external_event_id, series_id, updated_at)
     VALUES ('s1', 'Weekly Planning', '2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', 'gcal-e1', 'series-1', '2026-08-24T11:05:00.000Z')`,
  ).run();
  const words = JSON.stringify([
    {
      text: "Hello",
      speaker: { type: "unassigned", value: { index: 0 } },
      start_ms: 0,
      end_ms: 400,
    },
    {
      text: "everyone.",
      speaker: { type: "unassigned", value: { index: 0 } },
      start_ms: 450,
      end_ms: 900,
    },
    {
      text: "Hi!",
      speaker: { type: "assigned", value: { id: "h1", label: "Sam" } },
      start_ms: 1000,
      end_ms: 1200,
    },
  ]);
  db.prepare(
    `INSERT INTO transcripts (id, session_id, started_at_ms, words_json, updated_at)
     VALUES ('t1', 's1', 1787565600000, ?, '2026-08-24T11:00:00.000Z')`,
  ).run(words);
  db.prepare(
    `INSERT INTO session_documents (id, session_id, kind, title, body_format, body, updated_at)
     VALUES ('d1', 's1', 'note', 'Notes', 'markdown', 'Decision: ship it.\n\nNext step: tests.', '2026-08-24T11:02:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO session_participants (id, session_id, display_name, email)
     VALUES ('p1', 's1', 'Ivan', 'ivan@example.com')`,
  ).run();
  db.close();
};

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nomior-anarlog-"))),
    (dir) => Effect.scoped(use(dir)),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const makeInstance = (config: unknown) =>
  AnarlogDriver.create({
    accountId,
    displayName: undefined,
    config: decodeConfig(config),
  });

it.layer(NodeServices.layer)("AnarlogDriver", (it) => {
  it.effect("normalizes a meeting into transcript chunks and a linked note source", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = createFixtureStore(dir, {
          schemaVersion: ANARLOG_SCHEMA_VERSION_CEILING,
        });
        seedMeeting(storePath);
        const instance = yield* makeInstance({ storePath });

        const probe = yield* instance.probe;
        assert.isTrue(probe.present);
        assert.isTrue(probe.authorized);
        assert.deepEqual(yield* instance.health, { _tag: "ok" });

        const result = yield* instance.sync({ cursor: null });
        assert.isFalse(result.cursorInvalidated);
        assert.strictEqual(result.records.length, 2);

        const meeting = result.records[0];
        assert.strictEqual(meeting?.source.kind, "meeting_transcript");
        assert.strictEqual(meeting?.source.title, "Weekly Planning");
        assert.deepEqual(meeting?.source.links, {
          meetingSessionId: "s1",
          calendarEventId: "gcal-e1",
          recurringSeriesId: "series-1",
        });
        assert.deepEqual(meeting?.source.participants, [
          { name: "Ivan", email: "ivan@example.com" },
        ]);
        // Speaker turns: two chunks, speaker + timestamps preserved.
        assert.deepEqual(
          meeting?.chunks.map((chunk) => ({
            text: chunk.text,
            speaker: chunk.speaker,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
          })),
          [
            { text: "Hello everyone.", speaker: "Speaker 1", startMs: 0, endMs: 900 },
            { text: "Hi!", speaker: "Sam", startMs: 1000, endMs: 1200 },
          ],
        );

        const note = result.records[1];
        assert.strictEqual(note?.source.kind, "meeting_notes");
        assert.strictEqual(note?.source.links.meetingSessionId, "s1");
        assert.deepEqual(
          note?.chunks.map((chunk) => chunk.text),
          ["Decision: ship it.", "Next step: tests."],
        );
      }),
    ),
  );

  it.effect("advances the cursor and picks up only newer sessions", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = createFixtureStore(dir, {
          schemaVersion: ANARLOG_SCHEMA_VERSION_CEILING,
        });
        seedMeeting(storePath);
        const instance = yield* makeInstance({ storePath });

        const first = yield* instance.sync({ cursor: null });
        assert.strictEqual(first.records.length, 2);
        assert.isNotNull(first.nextCursor);

        // Nothing new: empty batch, cursor carried forward unchanged.
        const second = yield* instance.sync({ cursor: first.nextCursor });
        assert.strictEqual(second.records.length, 0);
        assert.strictEqual(second.nextCursor, first.nextCursor);

        // A newer session appears — only it comes back.
        const db = new NodeSqlite.DatabaseSync(storePath);
        db.prepare(
          `INSERT INTO sessions (id, title, updated_at)
           VALUES ('s2', 'Retro', '2026-08-25T09:00:00.000Z')`,
        ).run();
        db.close();
        const third = yield* instance.sync({ cursor: second.nextCursor });
        assert.deepEqual(
          third.records.map((record) => record.source.title),
          ["Retro"],
        );
        assert.notStrictEqual(third.nextCursor, second.nextCursor);
      }),
    ),
  );

  it.effect("refuses to parse an unknown schema version without a fallback", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = createFixtureStore(dir, { schemaVersion: 99990101000000n });
        seedMeeting(storePath);
        const instance = yield* makeInstance({ storePath });

        const health = yield* instance.health;
        assert.strictEqual(health._tag, "awaiting-update");

        const outcome = yield* instance.sync({ cursor: null }).pipe(Effect.flip);
        assert.instanceOf(outcome, ConnectorSchemaVersionError);
      }),
    ),
  );

  it.effect("degrades to the markdown export on an unknown schema version", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = createFixtureStore(dir, { schemaVersion: 99990101000000n });
        seedMeeting(storePath);

        const exportDir = NodePath.join(dir, "export");
        const sessionDir = NodePath.join(exportDir, "9f3a2b10-1111-2222-3333-444455556666");
        NodeFS.mkdirSync(sessionDir, { recursive: true });
        // The real fs-sync export shape: participants carry only opaque
        // ids (fs-sync-core types.rs::SessionMetaParticipant), never
        // name/email.
        NodeFS.writeFileSync(
          NodePath.join(sessionDir, "_meta.json"),
          JSON.stringify({
            id: "9f3a2b10-1111-2222-3333-444455556666",
            userId: "u1",
            createdAt: "2026-08-24T10:00:00.000Z",
            title: "Exported Meeting",
            event: null,
            eventId: null,
            participants: [
              {
                id: "p1",
                userId: "u1",
                sessionId: "9f3a2b10-1111-2222-3333-444455556666",
                humanId: "h1",
                source: "listing",
              },
            ],
            tags: [],
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(sessionDir, "transcript.json"),
          JSON.stringify({
            transcripts: [
              {
                id: "t1",
                started_at: 1787911200000,
                words: [
                  { text: "Hello", start_ms: 0, end_ms: 400, speaker: "S1" },
                  { text: "there", start_ms: 450, end_ms: 800, speaker: "S1" },
                ],
              },
            ],
          }),
        );
        NodeFS.writeFileSync(NodePath.join(sessionDir, "_memo.md"), "A memo line.\n");

        const instance = yield* makeInstance({ storePath, markdownExportPath: exportDir });

        const health = yield* instance.health;
        assert.strictEqual(health._tag, "awaiting-update");

        // Degraded but working: records come from the export, and a stale
        // SQLite cursor is reported invalidated.
        const result = yield* instance.sync({
          cursor: '{"updatedAt":"2026-08-24T11:05:00.000Z","sessionId":"s1"}',
        });
        assert.isTrue(result.cursorInvalidated);
        assert.isNull(result.nextCursor);
        assert.deepEqual(
          result.records.map((record) => record.source.title),
          ["Exported Meeting", "Exported Meeting"],
        );
        const meeting = result.records[0];
        // Id-only participants are dropped, not emitted as empty objects.
        assert.deepEqual(meeting?.source.participants, []);
        assert.deepEqual(
          meeting?.chunks.map((chunk) => ({ text: chunk.text, speaker: chunk.speaker })),
          [{ text: "Hello there", speaker: "S1" }],
        );
      }),
    ),
  );
});
