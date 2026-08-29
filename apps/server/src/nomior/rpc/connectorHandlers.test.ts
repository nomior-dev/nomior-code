// @effect-diagnostics nodeBuiltinImport:off - the Anarlog fixture store is a real on-disk sqlite file, built with raw node:sqlite/fs like AnarlogDriver.test.ts.
/**
 * The connector handlers against real stores.
 *
 * Everything under test here is an agreement between two pieces of code that a
 * fake would paper over: the client id survives a round trip through the same
 * secret store the token vault uses, disconnect clears rows in three different
 * tables, and the Anarlog detection is a real sqlite file being opened and its
 * migration ledger read. So the database is the shipped sqlite schema, the
 * secret store is the shipped file-backed one over a temp dir, and the Anarlog
 * store is a file on disk.
 *
 * Not covered, because it needs Google: the redirect half of `connect`. What is
 * covered is every way `connect` refuses before it opens a listener.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ConnectorAccountStore from "../connectors/ConnectorAccountStore.ts";
import * as ConnectorCursorStore from "../connectors/ConnectorCursorStore.ts";
import * as ConnectorSyncRunStore from "../connectors/ConnectorSyncRunStore.ts";
import { ConnectorContextIngest } from "../connectors/ContextIngestAdapter.ts";
import * as CalendarEventStore from "../connectors/calendar/CalendarEventStore.ts";
import {
  ConnectorAccountId,
  ConnectorDriverKind,
  type ConnectorRecord,
} from "../connectors/Records.ts";
import { NomiorSourceId } from "../context/Model.ts";
import { ANARLOG_SCHEMA_VERSION_CEILING } from "../connectors/anarlog/AnarlogSchema.ts";
import * as GoogleClientIdStore from "../connectors/google/GoogleClientIdStore.ts";
import * as GoogleTokenVault from "../connectors/google/GoogleTokenVault.ts";
import { GoogleTokenPortLive } from "../connectors/google/googleapisRuntime.ts";
import {
  connectConnector,
  disconnectConnector,
  listConnectors,
  setGoogleClientId,
} from "./connectorHandlers.ts";

const SecretStoreTest = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "nomior-connectors-test-" })),
);

/**
 * Titles the first sync a connect runs put through the ingest, newest last.
 *
 * The real adapter is the context engine's own test surface; here it stands in
 * so that "connect synced the account" is an assertion about records rather
 * than about wall-clock time.
 */
const ingestedTitles: string[] = [];

const recordIngest = (record: ConnectorRecord) =>
  Effect.sync(() => {
    ingestedTitles.push(record.source.title);
    return {
      sourceId: NomiorSourceId.make(record.source.provenance.externalId),
      chunkIds: [],
      replacedSourceId: null,
      canonicalText: "",
    };
  });

const IngestRecording = Layer.succeed(
  ConnectorContextIngest,
  ConnectorContextIngest.of({
    ingestRecord: recordIngest,
    ingestBatch: (records) => Effect.forEach(records, recordIngest),
  }),
);

const layer = it.layer(
  Layer.mergeAll(
    ConnectorAccountStore.layer,
    ConnectorCursorStore.layer,
    ConnectorSyncRunStore.layer,
    GoogleClientIdStore.layer,
    GoogleTokenVault.layer,
    // `connect` needs it in context even on the paths that refuse before
    // reaching Google; nothing here ever calls it, so nothing loads the SDK.
    GoogleTokenPortLive,
    // Connecting runs the account's first sync, so the whole sync runner
    // environment has to be here: every built-in driver's dependencies, not
    // only the one driver a given test connects.
    CalendarEventStore.layer,
    IngestRecording,
  ).pipe(
    Layer.provide(SecretStoreTest),
    Layer.provideMerge(SqlitePersistenceMemory),
    // Merged, not just provided: `listConnectors` reads the Anarlog store off
    // the real filesystem, so the tests need FileSystem and Path too.
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** A real Google client id's shape: a long opaque string ending in `.com`. */
const CLIENT_ID = "982374651028-3f9qmc7v1b0k2d8s6a4h5j7l9n1p3r5t.apps.googleusercontent.com";

const ANARLOG_KIND = ConnectorDriverKind.make("anarlog");
const GOOGLE_CALENDAR_KIND = ConnectorDriverKind.make("googleCalendar");

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nomior-connectors-"))),
    use,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const ANARLOG_SESSION_TITLE = "Weekly Planning";

/**
 * An Anarlog store the detector accepts and the driver can read.
 *
 * The migration ledger is all detection looks at, but connecting now runs the
 * account's first sync, so the store also carries the tables that sync reads
 * and one session for it to find. `AnarlogDriver.test.ts` owns the deep
 * coverage of those rows; this is the shallowest store that ingests anything.
 */
const seedAnarlogStore = (dir: string, version: bigint): string => {
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
  db.prepare("INSERT INTO _sqlx_migrations (version) VALUES (?)").run(version);
  db.prepare(
    `INSERT INTO sessions (id, title, started_at, ended_at, updated_at)
     VALUES ('s1', ?, '2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', '2026-08-24T11:05:00.000Z')`,
  ).run(ANARLOG_SESSION_TITLE);
  db.prepare(
    `INSERT INTO session_documents (id, session_id, kind, title, body_format, body, updated_at)
     VALUES ('d1', 's1', 'note', 'Notes', 'markdown', 'Decision: ship it.', '2026-08-24T11:02:00.000Z')`,
  ).run();
  db.close();
  return storePath;
};

const upsertAccount = (input: {
  readonly accountId: string;
  readonly driverKind: ConnectorDriverKind;
  readonly config: unknown;
}) =>
  Effect.gen(function* () {
    const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
    const accountId = ConnectorAccountId.make(input.accountId);
    yield* accounts.upsert({
      accountId,
      driverKind: input.driverKind,
      displayName: null,
      config: input.config,
      status: "connected",
      createdAt: "2026-08-29T09:00:00.000Z",
      updatedAt: "2026-08-29T09:00:00.000Z",
    });
    return accountId;
  });

/** Every string anywhere in a result, so a leak check does not need to guess. */
const stringsIn = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
};

const listDeps = Effect.gen(function* () {
  return {
    accounts: yield* ConnectorAccountStore.ConnectorAccountStore,
    syncRuns: yield* ConnectorSyncRunStore.ConnectorSyncRunStore,
    clientIds: yield* GoogleClientIdStore.GoogleClientIdStore,
    canStartLocalOAuth: true,
  };
});

describe("connector handlers over real stores", () => {
  layer((it) => {
    it.effect("round-trips the Google client id and hands back only its last four", () =>
      Effect.gen(function* () {
        const clientIds = yield* GoogleClientIdStore.GoogleClientIdStore;
        const deps = yield* listDeps;

        const before = yield* listConnectors(deps);
        assert.isFalse(before.google.configured, "no client id on a fresh install");
        assert.isNull(before.google.clientIdHint);

        yield* setGoogleClientId(clientIds, { clientId: CLIENT_ID });
        const configured = yield* listConnectors(deps);

        assert.isTrue(configured.google.configured);
        // From before the suffix every Google id shares, so it identifies one.
        assert.strictEqual(
          configured.google.clientIdHint,
          CLIENT_ID.replace(".apps.googleusercontent.com", "").slice(-4),
        );
        assert.strictEqual(configured.google.clientIdHint?.length, 4);
        // The whole value is in the store, and only in the store.
        assert.deepStrictEqual(yield* clientIds.get, Option.some(CLIENT_ID));
        assert.isFalse(
          stringsIn(configured).some((text) => text.includes(CLIENT_ID.slice(0, 20))),
          "the client id reached the wire result",
        );

        // An empty string is how the operator revokes the whole flow.
        yield* setGoogleClientId(clientIds, { clientId: "" });
        const cleared = yield* listConnectors(deps);
        assert.isFalse(cleared.google.configured);
        assert.isNull(cleared.google.clientIdHint);
        assert.isTrue(Option.isNone(yield* clientIds.get));
      }),
    );

    it.effect("reports an Anarlog store that is not where the account says it is", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath: NodePath.join(dir, "nothing-here.db") },
          });

          const { anarlog } = yield* listConnectors(yield* listDeps);
          assert.strictEqual(anarlog.detection, "notFound");
          assert.isNull(anarlog.storePath);
          assert.isNull(anarlog.schemaVersion);
        }),
      ),
    );

    it.effect("finds a real Anarlog store at the configured path", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const storePath = seedAnarlogStore(dir, ANARLOG_SCHEMA_VERSION_CEILING);
          yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath },
          });

          const { anarlog } = yield* listConnectors(yield* listDeps);
          assert.strictEqual(anarlog.detection, "found");
          assert.strictEqual(anarlog.storePath, storePath);
          assert.strictEqual(anarlog.schemaVersion, Number(ANARLOG_SCHEMA_VERSION_CEILING));
        }),
      ),
    );

    it.effect("calls a store past the tested ceiling unsupported, not missing", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const tooNew = ANARLOG_SCHEMA_VERSION_CEILING + 1n;
          const storePath = seedAnarlogStore(dir, tooNew);
          yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath },
          });

          const { anarlog } = yield* listConnectors(yield* listDeps);
          assert.strictEqual(anarlog.detection, "unsupportedSchema");
          assert.strictEqual(anarlog.storePath, storePath);
          assert.strictEqual(anarlog.schemaVersion, Number(tooNew));
        }),
      ),
    );

    it.effect("disconnect drops the account, its cursors and its sync history", () =>
      Effect.gen(function* () {
        const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
        const cursors = yield* ConnectorCursorStore.ConnectorCursorStore;
        const syncRuns = yield* ConnectorSyncRunStore.ConnectorSyncRunStore;
        const vault = yield* GoogleTokenVault.GoogleTokenVault;

        const accountId = yield* upsertAccount({
          accountId: "google_disconnect_me",
          driverKind: GOOGLE_CALENDAR_KIND,
          config: { calendarId: "primary" },
        });
        yield* cursors.set(accountId, "default", "sync-token-1");
        yield* syncRuns.record(accountId, "2026-08-29T09:30:00.000Z");
        yield* vault.set(accountId, { accessToken: "access-1", scopes: [] });

        const listed = yield* listConnectors(yield* listDeps);
        const row = listed.accounts.find((account) => account.id === accountId);
        assert.isDefined(row);
        assert.strictEqual(row.kind, "googleCalendar");
        assert.strictEqual(row.lastSyncedAt, "2026-08-29T09:30:00.000Z");

        yield* disconnectConnector({ accounts, cursors, syncRuns, vault }, { accountId });

        assert.isTrue(Option.isNone(yield* accounts.get(accountId)), "account row survived");
        assert.isTrue(
          Option.isNone(yield* cursors.get(accountId, "default")),
          "cursor row survived",
        );
        assert.isFalse((yield* syncRuns.lastSyncedAt()).has(accountId), "sync history survived");
        assert.isTrue(Option.isNone(yield* vault.get(accountId)), "stored credentials survived");
      }),
    );

    it.effect("disconnect refuses an unknown account without offering a retry", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          disconnectConnector(
            {
              accounts: yield* ConnectorAccountStore.ConnectorAccountStore,
              cursors: yield* ConnectorCursorStore.ConnectorCursorStore,
              syncRuns: yield* ConnectorSyncRunStore.ConnectorSyncRunStore,
              vault: yield* GoogleTokenVault.GoogleTokenVault,
            },
            { accountId: "google_nope" },
          ),
        );

        assert.strictEqual(error._tag, "NomiorRequestError");
        assert.isFalse(error.retryable);
        assert.include(error.message, "google_nope");
      }),
    );

    it.effect("an Anarlog account whose store has gone reports error, not connected", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const accountId = yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath: NodePath.join(dir, "moved-away.db") },
          });

          const { accounts, anarlog } = yield* listConnectors(yield* listDeps);
          const row = accounts.find((account) => account.id === accountId);
          assert.isDefined(row);

          // The row still says `connected` in the database; the store is gone.
          // Claiming health here would promise data the next sync cannot get.
          assert.strictEqual(anarlog.detection, "notFound");
          assert.strictEqual(row.status, "error");
          assert.isNotNull(row.detail);

          const accountStore = yield* ConnectorAccountStore.ConnectorAccountStore;
          yield* accountStore.remove(accountId);
        }),
      ),
    );

    it.effect("connecting Anarlog records the detected store instead of opening a browser", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
          const clientIds = yield* GoogleClientIdStore.GoogleClientIdStore;
          ingestedTitles.length = 0;
          const storePath = seedAnarlogStore(dir, ANARLOG_SCHEMA_VERSION_CEILING);
          // A prior row in `error` is the reconnect case, and it is also how the
          // test pins the store location without stubbing the platform's
          // default directories.
          const accountId = yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath },
          });
          yield* accounts.setStatus(accountId, "error");

          const result = yield* connectConnector(
            { accounts, clientIds, canStartLocalOAuth: true },
            { kind: "anarlog" },
          );

          // No sign-in link: there is no consent screen for a local file.
          assert.isNull(result.authorizationUrl);

          const stored = yield* accounts.listByDriver(ANARLOG_KIND);
          assert.strictEqual(stored.length, 1, "reconnect reused the row rather than orphaning it");
          assert.strictEqual(stored[0]!.accountId, accountId);
          assert.strictEqual(stored[0]!.status, "connected");
          assert.strictEqual(stored[0]!.displayName, storePath);

          // Connecting is the whole setup step: the account arrives synced, so
          // nothing waits on the user finding the Sync button afterwards.
          // The session and its note are two sources, as they are for a Sync.
          assert.deepStrictEqual(ingestedTitles, [ANARLOG_SESSION_TITLE, "Notes"]);
          const syncRuns = yield* ConnectorSyncRunStore.ConnectorSyncRunStore;
          assert.isTrue((yield* syncRuns.lastSyncedAt()).has(accountId));

          yield* accounts.remove(accountId);
        }),
      ),
    );

    it.effect("connecting Anarlog past the schema ceiling refuses and names the version", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
          const tooNew = ANARLOG_SCHEMA_VERSION_CEILING + 1n;
          const storePath = seedAnarlogStore(dir, tooNew);
          const accountId = yield* upsertAccount({
            accountId: "anarlog_local",
            driverKind: ANARLOG_KIND,
            config: { storePath },
          });

          const error = yield* Effect.flip(
            connectConnector(
              {
                accounts,
                clientIds: yield* GoogleClientIdStore.GoogleClientIdStore,
                canStartLocalOAuth: true,
              },
              { kind: "anarlog" },
            ),
          );

          // Detected and refused, never silently ingested with a reader that
          // does not understand the rows.
          assert.isFalse(error.retryable);
          assert.include(error.message, String(tooNew));
          yield* accounts.remove(accountId);
        }),
      ),
    );

    it.effect("connect refuses before opening a listener when nothing is configured", () =>
      Effect.gen(function* () {
        const clientIds = yield* GoogleClientIdStore.GoogleClientIdStore;
        yield* setGoogleClientId(clientIds, { clientId: "" });
        const deps = {
          accounts: yield* ConnectorAccountStore.ConnectorAccountStore,
          clientIds,
          canStartLocalOAuth: true,
        };

        const unset = yield* Effect.flip(connectConnector(deps, { kind: "gmail" }));
        assert.isFalse(unset.retryable);
        assert.include(unset.message, "client id");

        const remote = yield* Effect.flip(
          connectConnector({ ...deps, canStartLocalOAuth: false }, { kind: "googleCalendar" }),
        );
        assert.isFalse(remote.retryable);
        assert.include(remote.message, "server's own machine");
      }),
    );
  });
});
