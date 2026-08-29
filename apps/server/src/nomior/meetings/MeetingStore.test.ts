import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MeetingStore, layer as meetingStoreLayer, parseParticipants } from "./MeetingStore.ts";

// One database per test: `it.layer` would share the :memory: file across the
// block and every test here writes the same tables.
const storeLayer = meetingStoreLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

interface SourceRow {
  readonly id: string;
  readonly kind: "meeting" | "document";
  readonly title: string;
  readonly occurredAt: string | null;
  readonly provenance: Record<string, unknown>;
}

interface ChunkRow {
  readonly ordinal: number;
  readonly text: string;
  readonly speaker?: string | undefined;
  readonly tsStart?: number | undefined;
  readonly tsEnd?: number | undefined;
}

const encodeProvenance = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Rows in the shape `ContextIngest` writes. Written directly rather than
 * through the ingest service so a test can produce a row the seeder never
 * would — a meeting with no timing, a notes document with no meeting.
 */
const writeSource = (source: SourceRow, chunks: ReadonlyArray<ChunkRow>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO nomior_sources (id, kind, external_id, title, occurred_at, ingested_at, provenance_json)
      VALUES (
        ${source.id},
        ${source.kind},
        ${source.id},
        ${source.title},
        ${source.occurredAt},
        ${"2026-08-29T09:00:00.000Z"},
        ${encodeProvenance(source.provenance)}
      )
    `;
    for (const chunk of chunks) {
      yield* sql`
        INSERT INTO nomior_chunks (
          id, source_id, ordinal, text, contextual_prefix,
          char_start, char_end, speaker, ts_start, ts_end
        )
        VALUES (
          ${`${source.id}/${chunk.ordinal}`},
          ${source.id},
          ${chunk.ordinal},
          ${chunk.text},
          ${source.title},
          ${0},
          ${chunk.text.length},
          ${chunk.speaker ?? null},
          ${chunk.tsStart ?? null},
          ${chunk.tsEnd ?? null}
        )
      `;
    }
  });

const meetingSource = (
  id: string,
  overrides: {
    readonly occurredAt?: string | null;
    readonly sessionId?: string | null;
    readonly calendarEventId?: string | null;
    readonly participants?: ReadonlyArray<Record<string, string>>;
  } = {},
): SourceRow => ({
  id,
  kind: "meeting",
  title: id,
  occurredAt:
    overrides.occurredAt === undefined ? "2026-08-25T09:30:00.000Z" : overrides.occurredAt,
  provenance: {
    connector: "anarlog",
    connectorKind: "meeting_transcript",
    links: {
      ...(overrides.sessionId === null ? {} : { meetingSessionId: overrides.sessionId ?? id }),
      ...(overrides.calendarEventId === null
        ? {}
        : { calendarEventId: overrides.calendarEventId ?? `evt-${id}` }),
    },
    participants: overrides.participants ?? [{ name: "Ivan" }, { email: "oleg@nomior.example" }],
  },
});

const notesSource = (id: string, sessionId: string): SourceRow => ({
  id,
  kind: "document",
  title: `${id} — notes`,
  occurredAt: "2026-08-25T09:30:00.000Z",
  provenance: {
    connector: "anarlog",
    connectorKind: "meeting_notes",
    links: { meetingSessionId: sessionId },
    participants: [],
  },
});

it.effect("lists meetings newest first with their counts, duration and participants", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("older", { occurredAt: "2026-08-24T09:30:00.000Z" }), [
      { ordinal: 0, text: "Ivan: morning", speaker: "Ivan", tsStart: 8, tsEnd: 26 },
      { ordinal: 1, text: "Oleg: shipping", speaker: "Oleg", tsStart: 26, tsEnd: 94.4 },
    ]);
    yield* writeSource(meetingSource("newer", { occurredAt: "2026-08-26T09:30:00.000Z" }), [
      { ordinal: 0, text: "Ivan: one turn", speaker: "Ivan", tsStart: 0, tsEnd: 12 },
    ]);
    yield* writeSource(notesSource("older-notes", "older"), [{ ordinal: 0, text: "Decisions" }]);

    const meetings = yield* store.listMeetings({});
    assert.deepEqual(
      meetings.map((meeting) => meeting.id),
      ["newer", "older"],
    );

    const older = meetings[1]!;
    assert.strictEqual(older.turnCount, 2);
    assert.isTrue(older.hasNotes);
    // 94.4s to the last turn's end, rounded to whole milliseconds.
    assert.strictEqual(older.durationMs, 94_400);
    assert.strictEqual(older.calendarEventId, "evt-older");
    assert.deepEqual(older.participants, [
      { name: "Ivan", email: null },
      { name: null, email: "oleg@nomior.example" },
    ]);

    const newer = meetings[0]!;
    assert.strictEqual(newer.turnCount, 1);
    assert.isFalse(newer.hasNotes, "the notes document belongs to the other session");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("ignores sources that are not connector meetings", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    // Kind `meeting` but no connector provenance: a hand-ingested source, not a
    // recording the meetings panel can open.
    yield* writeSource(
      {
        id: "hand-ingested",
        kind: "meeting",
        title: "Hand ingested",
        occurredAt: "2026-08-25T09:30:00.000Z",
        provenance: { connector: "anarlog" },
      },
      [{ ordinal: 0, text: "text" }],
    );
    yield* writeSource(notesSource("orphan-notes", "no-such-session"), [
      { ordinal: 0, text: "Notes with no meeting" },
    ]);
    yield* writeSource(meetingSource("real"), [{ ordinal: 0, text: "Ivan: hello" }]);

    const meetings = yield* store.listMeetings({});
    assert.deepEqual(
      meetings.map((meeting) => meeting.id),
      ["real"],
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("applies the window half-open on the start and optionally on either end", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    const ids = [
      "2026-08-24T09:00:00.000Z",
      "2026-08-25T09:00:00.000Z",
      "2026-08-26T09:00:00.000Z",
    ];
    for (const occurredAt of ids) {
      yield* writeSource(meetingSource(occurredAt, { occurredAt }), []);
    }
    // A meeting the connector never gave a start: inside no bounded window.
    yield* writeSource(meetingSource("undated", { occurredAt: null }), []);

    const listed = (window: { rangeStart?: string; rangeEnd?: string }) =>
      Effect.map(store.listMeetings(window), (meetings) => meetings.map((meeting) => meeting.id));

    assert.deepEqual(yield* listed({ rangeStart: ids[1]! }), [ids[2]!, ids[1]!]);
    assert.deepEqual(yield* listed({ rangeEnd: ids[1]! }), [ids[0]!]);
    assert.deepEqual(yield* listed({ rangeStart: ids[0]!, rangeEnd: ids[2]! }), [ids[1]!, ids[0]!]);
    assert.include(yield* listed({}), "undated");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("returns the transcript in ordinal order, keeping null speaker and null timing", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("m1"), [
      { ordinal: 2, text: "third", speaker: "Oleg" },
      { ordinal: 0, text: "first", speaker: "Ivan", tsStart: 1.25, tsEnd: 2.5 },
      { ordinal: 1, text: "second" },
    ]);

    const detail = yield* store.getMeeting("m1");
    assert.deepEqual(
      detail.transcript.map((turn) => [turn.ordinal, turn.text, turn.speaker]),
      [
        [0, "first", "Ivan"],
        [1, "second", null],
        [2, "third", "Oleg"],
      ],
    );
    assert.deepEqual(
      detail.transcript.map((turn) => [turn.startMs, turn.endMs]),
      [
        [1250, 2500],
        [null, null],
        [null, null],
      ],
    );
    assert.deepEqual(
      detail.transcript.map((turn) => turn.id),
      ["m1/0", "m1/1", "m1/2"],
    );
    // No turn carries timing past the first, so the last timed end is the length.
    assert.strictEqual(detail.meeting.durationMs, 2500);
    assert.isNull(detail.notes);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("joins the notes document on the session id, in ordinal order", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("m1", { sessionId: "session-7" }), [
      { ordinal: 0, text: "Ivan: hello" },
    ]);
    yield* writeSource(notesSource("notes-a", "session-7"), [
      { ordinal: 1, text: "Second paragraph" },
      { ordinal: 0, text: "First paragraph" },
    ]);
    // Another session's notes must not leak into this meeting.
    yield* writeSource(notesSource("notes-b", "session-8"), [{ ordinal: 0, text: "Elsewhere" }]);

    const detail = yield* store.getMeeting("m1");
    assert.strictEqual(detail.notes, "First paragraph\n\nSecond paragraph");
    assert.isTrue(detail.meeting.hasNotes);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("reports a meeting with no session link as having no notes", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("unlinked", { sessionId: null }), [
      { ordinal: 0, text: "Ivan: hello" },
    ]);
    // A notes document whose link is also missing must not join by both being null.
    yield* writeSource(
      {
        id: "unlinked-notes",
        kind: "document",
        title: "Notes",
        occurredAt: null,
        provenance: { connectorKind: "meeting_notes", links: {} },
      },
      [{ ordinal: 0, text: "Loose notes" }],
    );

    const [meeting] = yield* store.listMeetings({});
    assert.isFalse(meeting?.hasNotes);
    const detail = yield* store.getMeeting("unlinked");
    assert.isNull(detail.notes);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("reports an empty transcript as no duration rather than zero", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("silent"), []);
    yield* writeSource(meetingSource("untimed"), [{ ordinal: 0, text: "Notes-only fallback" }]);

    const detail = yield* store.getMeeting("silent");
    assert.strictEqual(detail.meeting.turnCount, 0);
    assert.isNull(detail.meeting.durationMs);
    assert.isEmpty(detail.transcript);

    const untimed = yield* store.getMeeting("untimed");
    assert.strictEqual(untimed.meeting.turnCount, 1);
    assert.isNull(untimed.meeting.durationMs);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("fails with a not-found error for an unknown id", () =>
  Effect.gen(function* () {
    const store = yield* MeetingStore;
    yield* writeSource(meetingSource("m1"), []);
    // A document that exists but is not a meeting is just as absent.
    yield* writeSource(notesSource("notes-a", "m1"), []);

    for (const id of ["nope", "notes-a"]) {
      const error = yield* Effect.flip(store.getMeeting(id));
      assert.strictEqual(error._tag, "NomiorMeetingNotFoundError");
    }
  }).pipe(Effect.provide(storeLayer)),
);

it("keeps a malformed participants blob from costing the whole list", () => {
  assert.deepEqual(parseParticipants(null), []);
  assert.deepEqual(parseParticipants("not json"), []);
  assert.deepEqual(parseParticipants('{"name":"Ivan"}'), []);
  // Anarlog knows a name or an email, rarely both; entries with neither render
  // as an empty chip, so they are dropped.
  assert.deepEqual(parseParticipants('["Ivan", {}, {"name":"Dasha"}, {"email":"o@e.example"}]'), [
    { name: "Dasha", email: null },
    { name: null, email: "o@e.example" },
  ]);
});
