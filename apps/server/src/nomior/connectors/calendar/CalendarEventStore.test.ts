import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ConnectorAccountId } from "../Records.ts";
import {
  CalendarEventStore,
  layer as calendarEventStoreLayer,
  normalizeTimestamp,
  type StoredCalendarEvent,
} from "./CalendarEventStore.ts";

// One database per test: `it.layer` would share the :memory: file across the
// block and every test here reads the same window.
const storeLayer = calendarEventStoreLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const accountA = ConnectorAccountId.make("google_work");
const accountB = ConnectorAccountId.make("google_personal");

const event = (
  overrides: Partial<StoredCalendarEvent> & Pick<StoredCalendarEvent, "id" | "start" | "end">,
): StoredCalendarEvent => ({
  accountId: accountA,
  title: overrides.id,
  recurringSeriesId: null,
  meetingId: null,
  hasTranscript: false,
  hasNotes: false,
  ...overrides,
});

// Window: 09:00 → 10:00 on the same day.
const rangeStart = "2026-08-29T09:00:00.000Z";
const rangeEnd = "2026-08-29T10:00:00.000Z";

it.effect("returns exactly the events overlapping the half-open window", () =>
  Effect.gen(function* () {
    const store = yield* CalendarEventStore;
    yield* store.upsertMany([
      event({ id: "inside", start: "2026-08-29T09:15:00.000Z", end: "2026-08-29T09:45:00.000Z" }),
      event({ id: "spanning", start: "2026-08-29T08:00:00.000Z", end: "2026-08-29T11:00:00.000Z" }),
      event({
        id: "starts-before",
        start: "2026-08-29T08:30:00.000Z",
        end: "2026-08-29T09:30:00.000Z",
      }),
      event({ id: "ends-at-range-start", start: "2026-08-29T08:00:00.000Z", end: rangeStart }),
      event({ id: "starts-at-range-end", start: rangeEnd, end: "2026-08-29T10:30:00.000Z" }),
      event({
        id: "wholly-after",
        start: "2026-08-29T12:00:00.000Z",
        end: "2026-08-29T13:00:00.000Z",
      }),
    ]);

    const found = yield* store.listWindow({ rangeStart, rangeEnd });
    // Ordered by start. An event ending exactly at rangeStart and one starting
    // exactly at rangeEnd both fall outside [rangeStart, rangeEnd).
    assert.deepEqual(
      found.map((row) => row.id),
      ["spanning", "starts-before", "inside"],
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("orders events sharing a start by event id", () =>
  Effect.gen(function* () {
    const store = yield* CalendarEventStore;
    const start = "2026-08-29T09:05:00.000Z";
    const end = "2026-08-29T09:35:00.000Z";
    yield* store.upsertMany([
      event({ id: "c-sync", start, end }),
      event({ id: "a-sync", start, end }),
      event({ id: "b-sync", start, end }),
    ]);

    const found = yield* store.listWindow({ rangeStart, rangeEnd });
    assert.deepEqual(
      found.map((row) => row.id),
      ["a-sync", "b-sync", "c-sync"],
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("is idempotent on (accountId, id) and overwrites the stored row", () =>
  Effect.gen(function* () {
    const store = yield* CalendarEventStore;
    const base = event({
      id: "standup",
      start: "2026-08-29T09:15:00.000Z",
      end: "2026-08-29T09:30:00.000Z",
      title: "Standup",
    });
    yield* store.upsertMany([base]);
    yield* store.upsertMany([base]);
    assert.lengthOf(yield* store.listWindow({ rangeStart, rangeEnd }), 1);

    yield* store.upsertMany([
      {
        ...base,
        title: "Standup (moved)",
        end: "2026-08-29T09:45:00.000Z",
        recurringSeriesId: "series-9",
        meetingId: "meeting-1",
        hasTranscript: true,
        hasNotes: false,
      },
    ]);
    assert.deepEqual(yield* store.listWindow({ rangeStart, rangeEnd }), [
      {
        id: "standup",
        accountId: accountA,
        title: "Standup (moved)",
        start: "2026-08-29T09:15:00.000Z",
        end: "2026-08-29T09:45:00.000Z",
        recurringSeriesId: "series-9",
        meetingId: "meeting-1",
        hasTranscript: true,
        hasNotes: false,
      },
    ]);

    // The same event id under another account is a different row.
    yield* store.upsertMany([{ ...base, accountId: accountB }]);
    assert.lengthOf(yield* store.listWindow({ rangeStart, rangeEnd }), 2);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("deleteForAccount drops one account's events only", () =>
  Effect.gen(function* () {
    const store = yield* CalendarEventStore;
    const start = "2026-08-29T09:15:00.000Z";
    const end = "2026-08-29T09:45:00.000Z";
    yield* store.upsertMany([
      event({ id: "work-1", start, end }),
      event({ id: "work-2", start, end }),
      event({ id: "personal-1", accountId: accountB, start, end }),
    ]);

    yield* store.deleteForAccount(accountA);
    const remaining = yield* store.listWindow({ rangeStart, rangeEnd });
    assert.deepEqual(
      remaining.map((row) => [row.accountId, row.id]),
      [[accountB, "personal-1"]],
    );
  }).pipe(Effect.provide(storeLayer)),
);

it("normalizes timestamps to UTC ISO-8601 with milliseconds", () => {
  // Offsets, second precision and microsecond precision all have to land on
  // the one format the window query compares as strings.
  assert.deepEqual(
    normalizeTimestamp("2026-08-29T11:30:00+02:00"),
    Option.some("2026-08-29T09:30:00.000Z"),
  );
  assert.deepEqual(
    normalizeTimestamp("2026-08-29T09:30:00Z"),
    Option.some("2026-08-29T09:30:00.000Z"),
  );
  assert.deepEqual(
    normalizeTimestamp("2026-08-29T09:30:00.123456Z"),
    Option.some("2026-08-29T09:30:00.123Z"),
  );
  assert.isTrue(Option.isNone(normalizeTimestamp("not a timestamp")));
});
