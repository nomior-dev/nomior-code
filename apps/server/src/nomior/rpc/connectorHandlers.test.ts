/**
 * The connector handlers against real stores.
 *
 * Everything under test here is an agreement between two pieces of code that a
 * fake would paper over: the client id survives a round trip through the same
 * secret store the token vault uses, and disconnect clears rows in three
 * different tables. So the database is the shipped sqlite schema and the
 * secret store is the shipped file-backed one over a temp dir.
 *
 * Not covered, because it needs Google: the redirect half of `connect`. What is
 * covered is every way `connect` refuses before it opens a listener.
 */

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
    // Merged, not just provided: the handlers reach the real filesystem, so
    // the tests need FileSystem and Path too.
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** A real Google client id's shape: a long opaque string ending in `.com`. */
const CLIENT_ID = "982374651028-3f9qmc7v1b0k2d8s6a4h5j7l9n1p3r5t.apps.googleusercontent.com";

const GOOGLE_CALENDAR_KIND = ConnectorDriverKind.make("googleCalendar");

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
