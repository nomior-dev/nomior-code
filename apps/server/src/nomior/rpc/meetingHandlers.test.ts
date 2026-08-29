/**
 * The meeting handlers against a really-seeded database.
 *
 * Same reason as `panelHandlers.test.ts`: a meeting only exists as a shape
 * agreed between the writer's `provenance_json` and the reader's `json_extract`
 * path. A fake store built from the reader's own spelling agrees with it, so
 * only the real seeder can catch a query that looks for a key nobody writes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as MeetingStore from "../meetings/MeetingStore.ts";
import { DeterministicSeedRuntime } from "../seed/deterministic.ts";
import { SEED_NOW, seedMeetings } from "../seed/scenario.ts";
import { NomiorSeedServices, seedNomior } from "../seed/seed.ts";
import { getMeeting, listMeetings } from "./meetingHandlers.ts";

const seedRuntime = NomiorSeedServices.pipe(
  Layer.provideMerge(
    DeterministicSeedRuntime(SEED_NOW).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

const runSeed = seedNomior().pipe(Effect.provide(seedRuntime));

const layer = it.layer(
  MeetingStore.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

describe("meeting handlers over the seeded database", () => {
  layer((it) => {
    it.effect("returns every seeded meeting, newest first, with a transcript", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const { meetings } = yield* listMeetings(yield* MeetingStore.MeetingStore, {});

        assert.strictEqual(meetings.length, seedMeetings.length);
        const startedAt = meetings.map((meeting) => meeting.startedAt);
        assert.deepEqual(startedAt, startedAt.toSorted().toReversed());
        for (const meeting of meetings) {
          assert.isAbove(meeting.turnCount, 0, `${meeting.title} has no transcript`);
          assert.isAbove(meeting.participants.length, 0, `${meeting.title} has no participants`);
          assert.isNotNull(meeting.calendarEventId, `${meeting.title} lost its calendar link`);
        }
      }),
    );

    it.effect("reports the notes the seeder wrote as their own source", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const store = yield* MeetingStore.MeetingStore;
        const { meetings } = yield* listMeetings(store, {});

        const withNotes = meetings.filter((meeting) => meeting.hasNotes);
        assert.strictEqual(withNotes.length, meetings.length, "every seeded meeting has notes");

        const detail = yield* getMeeting(store, { meetingId: withNotes[0]!.id });
        assert.isNotNull(detail.notes);
        assert.isAbove(detail.notes!.length, 0);
        assert.strictEqual(detail.transcript.length, detail.meeting.turnCount);
        assert.deepEqual(
          detail.transcript.map((turn) => turn.ordinal),
          detail.transcript.map((_, index) => index),
        );

        // The panel renders speaker-attributed turns, which only exist because
        // the chunker stops merging at a speaker change. Before that, a whole
        // multi-speaker meeting collapsed into one chunk with a null speaker
        // and the names survived only inline as "Ivan: …" — a transcript the
        // UI could not lay out. Assert the shape the panel depends on.
        assert.isAbove(detail.transcript.length, 1, "transcript collapsed into a single turn");
        for (const turn of detail.transcript) {
          assert.isNotNull(turn.speaker, `turn ${turn.ordinal} lost its speaker`);
          assert.notMatch(
            turn.text,
            /^[^\n:]{1,40}: /u,
            "speaker is a field, not a prefix baked into the text",
          );
        }
        assert.isAbove(
          new Set(detail.transcript.map((turn) => turn.speaker)).size,
          1,
          "every turn attributed to one speaker",
        );
      }),
    );

    it.effect("carries the seeded participants and duration onto the wire", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const { meetings } = yield* listMeetings(yield* MeetingStore.MeetingStore, {});

        // The Friday review of 2026-08-28: three named attendees, last turn
        // ending 128 seconds in.
        const friday = meetings.find((meeting) => meeting.startedAt === "2026-08-28T13:00:00.000Z");
        assert.isDefined(friday);
        assert.deepEqual(
          friday.participants.map((participant) => participant.name),
          ["Ivan", "Dasha", "Oleg"],
        );
        assert.strictEqual(friday.durationMs, 128_000);
      }),
    );

    it.effect("moves the chunker's inline speaker label into the speaker field", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const store = yield* MeetingStore.MeetingStore;
        const { meetings } = yield* listMeetings(store, {});

        for (const meeting of meetings) {
          const detail = yield* getMeeting(store, { meetingId: meeting.id });
          const first = detail.transcript[0];
          assert.isDefined(first, `${meeting.title} has no turns`);
          // `renderSegment` writes "Ivan: …" into the canonical text, where the
          // evidence spans and FTS need it. The panel renders the speaker as
          // its own field, so the read model hands back the words only.
          assert.isNotNull(first.speaker, `${meeting.title}: turn 0 has no speaker`);
          assert.notMatch(
            first.text,
            new RegExp(`^${first.speaker}: `, "u"),
            `${meeting.title}: turn 0 still carries its speaker label inline`,
          );
        }
      }),
    );

    it.effect("windows the list on the meeting start", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const store = yield* MeetingStore.MeetingStore;
        const { meetings } = yield* listMeetings(store, {
          rangeStart: "2026-08-24T00:00:00.000Z",
          rangeEnd: "2026-08-25T00:00:00.000Z",
        });

        assert.deepEqual(
          meetings.map((meeting) => meeting.startedAt),
          ["2026-08-24T09:30:00.000Z"],
        );
      }),
    );

    it.effect("refuses an unknown meeting id without offering a retry", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const error = yield* Effect.flip(
          getMeeting(yield* MeetingStore.MeetingStore, { meetingId: "meet-nope" }),
        );

        assert.strictEqual(error._tag, "NomiorRequestError");
        assert.isFalse(error.retryable);
        assert.include(error.message, "meet-nope");
      }),
    );
  });
});
