// @effect-diagnostics nodeBuiltinImport:off - fixture stores are built with raw node:sqlite/fs.
/**
 * Safety contract for reading another running app's SQLite file.
 *
 * `AnarlogDriver.test.ts` covers normalization and the schema-version gate;
 * this file covers the part that can damage someone else's data: the store is
 * opened read-only, holds no lock against a live writer, and never surfaces
 * rows the owning app hides from its own user — deleted or device-auth locked.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ANARLOG_SCHEMA_VERSION_CEILING, ANARLOG_SCHEMA_VERSION_FLOOR } from "./AnarlogSchema.ts";
import { openAnarlogStore } from "./AnarlogStore.ts";

/**
 * `sessions.locked` only exists from anarlog migration 20260820120000, which
 * is above our schema floor — so both shapes are inside the supported range
 * and both have to be readable.
 */
const ddl = (lockedColumn: boolean) => `
  CREATE TABLE _sqlx_migrations (
    version INTEGER PRIMARY KEY,
    success INTEGER NOT NULL DEFAULT 1
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
    deleted_at TEXT${lockedColumn ? ",\n    locked INTEGER NOT NULL DEFAULT 0" : ""}
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
`;

const words = JSON.stringify([{ text: "Hello", start_ms: 0, end_ms: 200 }]);

const lockedWords = JSON.stringify([{ text: "Salary", start_ms: 0, end_ms: 200 }]);

/**
 * One live session, one soft-deleted session and (when the column exists) one
 * device-auth locked session, each with a live and a soft-deleted child row of
 * every kind.
 */
const createFixture = (options?: { readonly lockedColumn?: boolean }): string => {
  const lockedColumn = options?.lockedColumn ?? true;
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "anarlog-store-"));
  const storePath = NodePath.join(dir, "app.db");
  const db = new NodeSqlite.DatabaseSync(storePath);
  db.exec(ddl(lockedColumn));
  db.prepare("INSERT INTO _sqlx_migrations (version) VALUES (?)").run(
    lockedColumn ? ANARLOG_SCHEMA_VERSION_CEILING : ANARLOG_SCHEMA_VERSION_FLOOR,
  );
  if (lockedColumn) {
    // Newest row in the store, so a filter that merely ordered it last would
    // not hide it.
    db.exec(`
      INSERT INTO sessions (id, title, updated_at, locked)
        VALUES ('locked-note', 'Locked 1:1', '2026-08-27T10:00:00.000Z', 1);
      INSERT INTO transcripts (id, session_id, started_at_ms, words_json, updated_at)
        VALUES ('t-locked', 'locked-note', 0, '${lockedWords}', '2026-08-27T10:01:00.000Z');
      INSERT INTO session_documents (id, session_id, title, body, updated_at)
        VALUES ('d-locked', 'locked-note', 'Locked notes', 'confidential', '2026-08-27T10:01:00.000Z');
      INSERT INTO session_participants (id, session_id, display_name, email, updated_at)
        VALUES ('p-locked', 'locked-note', 'Manager', 'manager@example.test', '2026-08-27T10:01:00.000Z');
    `);
  }
  db.exec(`
    INSERT INTO sessions (id, title, updated_at) VALUES ('live', 'Live meeting', '2026-08-24T10:00:00.000Z');
    INSERT INTO sessions (id, title, updated_at, deleted_at)
      VALUES ('gone', 'Deleted meeting', '2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z');
    INSERT INTO transcripts (id, session_id, started_at_ms, words_json, updated_at)
      VALUES ('t-live', 'live', 0, '${words}', '2026-08-24T10:01:00.000Z');
    INSERT INTO transcripts (id, session_id, started_at_ms, words_json, updated_at, deleted_at)
      VALUES ('t-gone', 'live', 10, '${words}', '2026-08-24T10:02:00.000Z', '2026-08-24T10:03:00.000Z');
    INSERT INTO session_documents (id, session_id, title, body, updated_at)
      VALUES ('d-live', 'live', 'Notes', 'kept', '2026-08-24T10:01:00.000Z');
    INSERT INTO session_documents (id, session_id, title, body, updated_at, deleted_at)
      VALUES ('d-gone', 'live', 'Scratch', 'removed', '2026-08-24T10:02:00.000Z', '2026-08-24T10:03:00.000Z');
    INSERT INTO session_participants (id, session_id, display_name, email, updated_at)
      VALUES ('p-live', 'live', 'Ivan', 'ivan@example.test', '2026-08-24T10:01:00.000Z');
    INSERT INTO session_participants (id, session_id, display_name, email, updated_at, deleted_at)
      VALUES ('p-gone', 'live', 'Removed Guest', 'guest@example.test', '2026-08-24T10:02:00.000Z', '2026-08-24T10:03:00.000Z');
  `);
  db.close();
  return storePath;
};

const readBundles = (storePath: string) =>
  Effect.scoped(
    Effect.flatMap(openAnarlogStore(storePath), (store) => store.listSessionBundlesSince(null, 50)),
  );

describe("openAnarlogStore", () => {
  it.effect("never writes: the store's bytes are identical after a full read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storePath = createFixture();
      const before = yield* fs.readFile(storePath);

      yield* readBundles(storePath);
      yield* Effect.scoped(
        Effect.flatMap(openAnarlogStore(storePath), (store) => store.schemaVersion),
      );

      const after = yield* fs.readFile(storePath);
      assert.deepStrictEqual([...after], [...before]);
      // No stray journal, WAL, or shm file was created either: a writer would
      // have left one behind.
      const path = yield* Path.Path;
      const siblings = yield* fs.readDirectory(path.dirname(storePath));
      assert.deepStrictEqual([...siblings].sort(), ["app.db"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("holds no lock: the owning app can keep writing while we read", () =>
    Effect.gen(function* () {
      const storePath = createFixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openAnarlogStore(storePath);
          yield* store.listSessionBundlesSince(null, 50);

          // Anarlog itself, mid-read: this must not raise SQLITE_BUSY.
          const owner = new NodeSqlite.DatabaseSync(storePath);
          owner
            .prepare("INSERT INTO sessions (id, title, updated_at) VALUES (?, ?, ?)")
            .run("added-by-owner", "Added while reading", "2026-08-26T10:00:00.000Z");
          owner.close();

          // And a reader opened after that write still sees a consistent store.
          const again = yield* store.listSessionBundlesSince(null, 50);
          assert.isAtLeast(again.length, 1);
        }),
      );

      const bundles = yield* readBundles(storePath);
      assert.include(
        bundles.map((bundle) => bundle.session.id),
        "added-by-owner",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("cannot write through the connection it opened", () => {
    const storePath = createFixture();
    // The reader exposes no write path, so this asserts the connection
    // itself: a handle opened exactly the way the store opens one must refuse
    // every write, and report `query_only` on as the second guard.
    const connection = new NodeSqlite.DatabaseSync(storePath, { readOnly: true });
    connection.exec("PRAGMA query_only = ON");
    assert.throws(() => connection.exec("INSERT INTO sessions (id, updated_at) VALUES ('x', 'y')"));
    assert.throws(() => connection.exec("DELETE FROM sessions"));
    assert.throws(() => connection.exec("DROP TABLE sessions"));
    const queryOnly = connection.prepare("PRAGMA query_only").get() as {
      readonly query_only: number;
    };
    assert.strictEqual(queryOnly.query_only, 1);
    connection.close();
  });

  /**
   * Structural guard: the two refusals above only hold while the open call
   * asks for them. A regression that drops either flag would still pass every
   * behavioral test in this file, because nothing we expose writes.
   */
  it.effect("opens with both readOnly and query_only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.readFileString(path.join(import.meta.dirname, "AnarlogStore.ts"));
      assert.match(source, /new NodeSqlite\.DatabaseSync\([^)]*\{\s*readOnly:\s*true\s*\}\)/);
      assert.match(source, /PRAGMA query_only = ON/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("honors deleted_at on sessions and on every child table", () =>
    Effect.gen(function* () {
      const bundles = yield* readBundles(createFixture());

      assert.deepStrictEqual(
        bundles.map((bundle) => bundle.session.id),
        ["live"],
        "a soft-deleted session must not be ingested",
      );
      const live = bundles[0];
      assert.isDefined(live);
      assert.deepStrictEqual(
        live.transcripts.map((row) => row.id),
        ["t-live"],
      );
      assert.deepStrictEqual(
        live.documents.map((row) => row.id),
        ["d-live"],
      );
      assert.deepStrictEqual(
        live.participants.map((row) => row.displayName),
        ["Ivan"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never ingests a session the desktop app holds behind device auth", () =>
    Effect.gen(function* () {
      const bundles = yield* readBundles(createFixture());

      assert.deepStrictEqual(
        bundles.map((bundle) => bundle.session.id),
        ["live"],
        "a locked session must not be ingested: retrieval has no device auth to re-impose",
      );
      // And nothing of it leaks through a child table either.
      const everything = bundles.flatMap((bundle) => [
        bundle.session.id,
        ...bundle.transcripts.flatMap((row) => [row.id, ...row.words.map((word) => word.text)]),
        ...bundle.documents.flatMap((row) => [row.id, row.body]),
        ...bundle.participants.map((row) => row.sessionId),
      ]);
      assert.notInclude(everything, "locked-note");
      assert.notInclude(everything, "confidential");
      assert.notInclude(everything, "Salary");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * The lock column landed above the schema floor, so stores in the lower half
   * of the supported range still have to read: an unconditional `locked = 0`
   * would fail every sync there with "no such column".
   */
  it.effect("still reads a store from before the locked column existed", () =>
    Effect.gen(function* () {
      const bundles = yield* readBundles(createFixture({ lockedColumn: false }));

      assert.deepStrictEqual(
        bundles.map((bundle) => bundle.session.id),
        ["live"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no schema version when the migrations table is absent", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "anarlog-bare-"));
      const storePath = NodePath.join(dir, "app.db");
      const db = new NodeSqlite.DatabaseSync(storePath);
      db.exec("CREATE TABLE unrelated (a)");
      db.close();

      const version = yield* Effect.scoped(
        Effect.flatMap(openAnarlogStore(storePath), (store) => store.schemaVersion),
      );
      // None, not a guess — the driver turns this into "awaiting-update".
      assert.isTrue(Option.isNone(version));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
