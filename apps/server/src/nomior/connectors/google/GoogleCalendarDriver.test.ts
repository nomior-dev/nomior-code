import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CalendarEventStore, type StoredCalendarEvent } from "../calendar/CalendarEventStore.ts";
import { ConnectorSyncError } from "../Errors.ts";
import { ConnectorAccountId } from "../Records.ts";
import { GoogleCalendarDriver } from "./GoogleCalendarDriver.ts";
import {
  GoogleApiError,
  type GoogleCalendarListInput,
  type GoogleCalendarListPage,
  GoogleCalendarPort,
  GoogleTokenPort,
  type GoogleTokenSet,
} from "./GooglePorts.ts";
import { GoogleTokenVault, GoogleTokenVaultError } from "./GoogleTokenVault.ts";

const accountA = ConnectorAccountId.make("google_work");
const accountB = ConnectorAccountId.make("google_personal");

const decodeConfig = Schema.decodeUnknownSync(GoogleCalendarDriver.configSchema);

const tokenSet = (marker: string): GoogleTokenSet => ({
  accessToken: `access-${marker}`,
  refreshToken: `refresh-${marker}`,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
});

interface VaultFake {
  readonly layer: Layer.Layer<GoogleTokenVault>;
  readonly store: Map<string, GoogleTokenSet>;
}

const makeVaultFake = (initial: ReadonlyArray<[ConnectorAccountId, GoogleTokenSet]>): VaultFake => {
  const store = new Map<string, GoogleTokenSet>(initial);
  return {
    store,
    layer: Layer.succeed(
      GoogleTokenVault,
      GoogleTokenVault.of({
        get: (accountId) => Effect.sync(() => Option.fromNullishOr(store.get(accountId))),
        set: (accountId, tokens) => Effect.sync(() => void store.set(accountId, tokens)),
        remove: (accountId) => Effect.sync(() => void store.delete(accountId)),
      }),
    ),
  };
};

interface TokenPortFake {
  readonly layer: Layer.Layer<GoogleTokenPort>;
  readonly revoked: Array<string>;
}

const makeTokenPortFake = (): TokenPortFake => {
  const revoked: Array<string> = [];
  return {
    revoked,
    layer: Layer.succeed(
      GoogleTokenPort,
      GoogleTokenPort.of({
        exchangeAuthorizationCode: () => Effect.succeed(tokenSet("exchanged")),
        refreshAccessToken: () => Effect.succeed(tokenSet("refreshed")),
        revokeToken: ({ token }) => Effect.sync(() => void revoked.push(token)),
      }),
    ),
  };
};

interface EventStoreFake {
  readonly layer: Layer.Layer<CalendarEventStore>;
  readonly upserted: Array<StoredCalendarEvent>;
  readonly deleted: Array<ConnectorAccountId>;
}

const makeEventStoreFake = (): EventStoreFake => {
  const upserted: Array<StoredCalendarEvent> = [];
  const deleted: Array<ConnectorAccountId> = [];
  return {
    upserted,
    deleted,
    layer: Layer.succeed(
      CalendarEventStore,
      CalendarEventStore.of({
        upsertMany: (events) => Effect.sync(() => void upserted.push(...events)),
        listWindow: () => Effect.succeed([]),
        deleteForAccount: (accountId) => Effect.sync(() => void deleted.push(accountId)),
      }),
    ),
  };
};

const calendarPortLayer = (
  handler: (
    input: GoogleCalendarListInput,
  ) => Effect.Effect<GoogleCalendarListPage, GoogleApiError>,
): Layer.Layer<GoogleCalendarPort> =>
  Layer.succeed(
    GoogleCalendarPort,
    GoogleCalendarPort.of({
      listEvents: handler,
      // Only connect reads it, to label the account; sync never does.
      primaryAddress: () => Effect.succeed("ivan@example.com"),
    }),
  );

const makeInstance = (accountId: ConnectorAccountId) =>
  GoogleCalendarDriver.create({ accountId, displayName: undefined, config: decodeConfig({}) });

it.effect("advances the sync token across pages and flags recurring series", () =>
  Effect.gen(function* () {
    const instance = yield* makeInstance(accountA);

    const first = yield* instance.sync({ cursor: null });
    assert.isFalse(first.cursorInvalidated);
    assert.strictEqual(first.nextCursor, '{"syncToken":"sync-1"}');
    // e2 is cancelled — a tombstone, skipped.
    assert.deepEqual(
      first.records.map((record) => record.source.sourceId),
      ["event:e1", "event:e2b", "event:e3"],
    );
    const recurring = first.records[2];
    assert.strictEqual(recurring?.source.links.recurringSeriesId, "series-9");
    assert.strictEqual(recurring?.source.provenance.accountId, accountA);

    const second = yield* instance.sync({ cursor: first.nextCursor });
    assert.isFalse(second.cursorInvalidated);
    assert.strictEqual(second.nextCursor, '{"syncToken":"sync-2"}');
    assert.deepEqual(
      second.records.map((record) => record.source.sourceId),
      ["event:e4"],
    );

    // The port saw the stored token on the incremental call only.
    assert.deepEqual(
      capturedCalls.map((input) => input.syncToken),
      [undefined, undefined, "sync-1"],
    );
    // Token-less (initial) walks are time-bounded so a decade-old calendar
    // cannot force an unbounded history walk; token walks must never be
    // (Google forbids timeMin + syncToken together).
    assert.deepEqual(
      capturedCalls.map((input) => input.timeMin !== undefined),
      [true, true, false],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        calendarPortLayerWithCapture(),
        makeVaultFake([[accountA, tokenSet("a")]]).layer,
        makeTokenPortFake().layer,
        makeEventStoreFake().layer,
      ),
    ),
  ),
);

// Captured-calls variant used by the paging test above; hoisted so both the
// handler and the assertions share one call log per test run.
let capturedCalls: Array<GoogleCalendarListInput> = [];
function calendarPortLayerWithCapture(): Layer.Layer<GoogleCalendarPort> {
  capturedCalls = [];
  return calendarPortLayer((input) => {
    capturedCalls.push(input);
    if (input.syncToken === "sync-1") {
      return Effect.succeed({ items: [{ id: "e4" }], nextSyncToken: "sync-2" });
    }
    if (input.pageToken === "p2") {
      return Effect.succeed({
        items: [{ id: "e3", recurringEventId: "series-9" }],
        nextSyncToken: "sync-1",
      });
    }
    return Effect.succeed({
      items: [
        { id: "e1", summary: "Standup" },
        { id: "e2", status: "cancelled" },
        { id: "e2b", summary: "Planning" },
      ],
      nextPageToken: "p2",
    });
  });
}

it.effect("performs a full resync on 410 GONE and reports the invalidated cursor", () =>
  Effect.gen(function* () {
    const instance = yield* makeInstance(accountA);
    const result = yield* instance.sync({ cursor: '{"syncToken":"sync-expired"}' });
    assert.isTrue(result.cursorInvalidated);
    assert.strictEqual(result.nextCursor, '{"syncToken":"sync-fresh"}');
    assert.deepEqual(
      result.records.map((record) => record.source.sourceId),
      ["event:full1"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        calendarPortLayer((input) =>
          input.syncToken === "sync-expired"
            ? Effect.fail(new GoogleApiError({ status: 410, operation: "calendar.events.list" }))
            : Effect.succeed({ items: [{ id: "full1" }], nextSyncToken: "sync-fresh" }),
        ),
        makeVaultFake([[accountA, tokenSet("a")]]).layer,
        makeTokenPortFake().layer,
        makeEventStoreFake().layer,
      ),
    ),
  ),
);

it.effect("surfaces non-invalidation API failures as ConnectorSyncError", () =>
  Effect.gen(function* () {
    const instance = yield* makeInstance(accountA);
    const failure = yield* instance.sync({ cursor: '{"syncToken":"sync-1"}' }).pipe(Effect.flip);
    assert.instanceOf(failure, ConnectorSyncError);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        calendarPortLayer(() =>
          Effect.fail(new GoogleApiError({ status: 500, operation: "calendar.events.list" })),
        ),
        makeVaultFake([[accountA, tokenSet("a")]]).layer,
        makeTokenPortFake().layer,
        makeEventStoreFake().layer,
      ),
    ),
  ),
);

it.effect("isolates accounts: separate data, credentials, and revocation", () =>
  Effect.gen(function* () {
    const vault = makeVaultFake([
      [accountA, tokenSet("a")],
      [accountB, tokenSet("b")],
    ]);
    const tokenPort = makeTokenPortFake();
    const eventStore = makeEventStoreFake();
    const layers = Layer.mergeAll(
      calendarPortLayer((input) =>
        Effect.succeed({
          items: [{ id: `${input.accountId}-event` }],
          nextSyncToken: `sync-${input.accountId}`,
        }),
      ),
      vault.layer,
      tokenPort.layer,
      eventStore.layer,
    );

    yield* Effect.gen(function* () {
      const instanceA = yield* makeInstance(accountA);
      const instanceB = yield* makeInstance(accountB);

      const resultA = yield* instanceA.sync({ cursor: null });
      const resultB = yield* instanceB.sync({ cursor: null });
      // Each account sees only its own stream and cursor.
      assert.deepEqual(
        resultA.records.map((record) => record.source.provenance.accountId),
        [accountA],
      );
      assert.strictEqual(resultA.nextCursor, `{"syncToken":"sync-${accountA}"}`);
      assert.strictEqual(resultB.nextCursor, `{"syncToken":"sync-${accountB}"}`);

      // Revoking A drops only A's credentials.
      yield* instanceA.revoke;
      assert.isFalse(vault.store.has(accountA));
      assert.isTrue(vault.store.has(accountB));
      assert.deepEqual(tokenPort.revoked, ["refresh-a"]);
      // The grid stops showing a disconnected account.
      assert.deepEqual(eventStore.deleted, [accountA]);

      const healthA = yield* instanceA.health;
      const healthB = yield* instanceB.health;
      assert.strictEqual(healthA._tag, "unauthorized");
      assert.strictEqual(healthB._tag, "ok");
    }).pipe(Effect.scoped, Effect.provide(layers));
  }),
);

it.effect("stores timed events for the grid without touching context records", () =>
  Effect.gen(function* () {
    const eventStore = makeEventStoreFake();
    yield* Effect.gen(function* () {
      const instance = yield* makeInstance(accountA);
      const result = yield* instance.sync({ cursor: null });

      // Both surfaces see the timed events; only the grid drops the all-day one.
      assert.deepEqual(
        result.records.map((record) => record.source.sourceId),
        ["event:timed", "event:all-day", "event:recurring"],
      );
      assert.deepEqual(eventStore.upserted, [
        {
          id: "timed",
          accountId: accountA,
          title: "Design review",
          // Written back as UTC with milliseconds regardless of the offset
          // Google sent, because the window query compares strings.
          start: "2026-08-29T09:30:00.000Z",
          end: "2026-08-29T10:00:00.000Z",
          recurringSeriesId: null,
          meetingId: null,
          hasTranscript: false,
          hasNotes: false,
        },
        {
          id: "recurring",
          accountId: accountA,
          title: "",
          start: "2026-08-30T09:00:00.000Z",
          end: "2026-08-30T09:15:00.000Z",
          recurringSeriesId: "series-9",
          meetingId: null,
          hasTranscript: false,
          hasNotes: false,
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          calendarPortLayer(() =>
            Effect.succeed({
              items: [
                {
                  id: "timed",
                  summary: "Design review",
                  start: { dateTime: "2026-08-29T11:30:00+02:00" },
                  end: { dateTime: "2026-08-29T12:00:00+02:00" },
                },
                {
                  id: "all-day",
                  summary: "Company offsite",
                  start: { date: "2026-08-29" },
                  end: { date: "2026-08-30" },
                },
                {
                  id: "recurring",
                  recurringEventId: "series-9",
                  start: { dateTime: "2026-08-30T09:00:00.000Z" },
                  end: { dateTime: "2026-08-30T09:15:00.000Z" },
                },
              ],
              nextSyncToken: "sync-1",
            }),
          ),
          makeVaultFake([[accountA, tokenSet("a")]]).layer,
          makeTokenPortFake().layer,
          eventStore.layer,
        ),
      ),
    );
  }),
);

it.effect("vault errors degrade probe and health instead of failing", () =>
  Effect.gen(function* () {
    const brokenVault = Layer.succeed(
      GoogleTokenVault,
      GoogleTokenVault.of({
        get: (accountId) => Effect.fail(new GoogleTokenVaultError({ operation: "get", accountId })),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    );
    yield* Effect.gen(function* () {
      const instance = yield* makeInstance(accountA);
      const probe = yield* instance.probe;
      assert.isFalse(probe.authorized);
      const health = yield* instance.health;
      assert.strictEqual(health._tag, "unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          calendarPortLayer(() => Effect.succeed({ items: [], nextSyncToken: "s" })),
          brokenVault,
          makeTokenPortFake().layer,
          makeEventStoreFake().layer,
        ),
      ),
    );
  }),
);
