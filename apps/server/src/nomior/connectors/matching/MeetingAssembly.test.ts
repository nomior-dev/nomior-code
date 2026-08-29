import { assert, describe, it } from "@effect/vitest";

import { ConnectorAccountId, ConnectorDriverKind, type ConnectorSource } from "../Records.ts";
import {
  assembleMeetings,
  participantOverlap,
  timeOverlapScore,
  titleSimilarity,
} from "./MeetingAssembly.ts";

const recorderKind = ConnectorDriverKind.make("recorder");
const calendarKind = ConnectorDriverKind.make("googleCalendar");
const gmailKind = ConnectorDriverKind.make("gmail");
const recorderAccount = ConnectorAccountId.make("recorder_local");
const calendarAccount = ConnectorAccountId.make("google_work");
const gmailAccount = ConnectorAccountId.make("gmail_work");

const transcript = (overrides: Partial<ConnectorSource>): ConnectorSource => ({
  sourceId: "session:s1",
  kind: "meeting_transcript",
  title: "Weekly Planning",
  startedAt: "2026-08-24T10:02:00.000Z",
  endedAt: "2026-08-24T10:58:00.000Z",
  participants: [{ name: "Ivan", email: "ivan@example.com" }, { email: "sam@example.com" }],
  links: { meetingSessionId: "s1" },
  provenance: { driverKind: recorderKind, accountId: recorderAccount, externalId: "s1" },
  ...overrides,
});

const event = (id: string, overrides: Partial<ConnectorSource>): ConnectorSource => ({
  sourceId: `event:${id}`,
  kind: "calendar_event",
  title: "Weekly Planning",
  startedAt: "2026-08-24T10:00:00.000Z",
  endedAt: "2026-08-24T11:00:00.000Z",
  participants: [{ email: "ivan@example.com" }, { email: "sam@example.com" }],
  links: { calendarEventId: id },
  provenance: { driverKind: calendarKind, accountId: calendarAccount, externalId: id },
  ...overrides,
});

const mail = (
  id: string,
  threadId: string,
  overrides: Partial<ConnectorSource>,
): ConnectorSource => ({
  sourceId: `message:${id}`,
  kind: "mail_message",
  title: "Weekly Planning agenda",
  startedAt: "2026-08-23T18:00:00.000Z",
  participants: [{ email: "ivan@example.com" }, { email: "sam@example.com" }],
  links: { mailThreadId: threadId },
  provenance: { driverKind: gmailKind, accountId: gmailAccount, externalId: id },
  ...overrides,
});

describe("scoring primitives", () => {
  it("titleSimilarity is 1 for identical token sets and 0 for disjoint ones", () => {
    assert.strictEqual(titleSimilarity("Weekly Planning", "planning weekly"), 1);
    assert.strictEqual(titleSimilarity("Weekly Planning", "Budget Review"), 0);
    assert.strictEqual(titleSimilarity("", "anything"), 0);
  });

  it("participantOverlap matches by email over the smaller side", () => {
    assert.strictEqual(
      participantOverlap(
        [{ email: "a@x.com" }, { email: "b@x.com" }],
        [{ email: "A@x.com" }, { email: "c@x.com" }, { email: "d@x.com" }],
      ),
      0.5,
    );
    assert.strictEqual(participantOverlap([], [{ email: "a@x.com" }]), 0);
  });

  it("timeOverlapScore rewards interval overlap and start proximity", () => {
    assert.strictEqual(
      timeOverlapScore(
        { startedAt: "2026-08-24T10:00:00Z", endedAt: "2026-08-24T11:00:00Z" },
        { startedAt: "2026-08-24T10:00:00Z", endedAt: "2026-08-24T11:00:00Z" },
      ),
      1,
    );
    assert.strictEqual(
      timeOverlapScore(
        { startedAt: "2026-08-24T10:00:00Z", endedAt: "2026-08-24T11:00:00Z" },
        { startedAt: "2026-08-24T14:00:00Z", endedAt: "2026-08-24T15:00:00Z" },
      ),
      0,
    );
    assert.strictEqual(
      timeOverlapScore(
        { startedAt: "2026-08-24T10:00:00Z" },
        { startedAt: "2026-08-24T10:03:00Z" },
      ),
      1,
    );
  });
});

describe("assembleMeetings", () => {
  it("attaches the matching event with per-field provenance", () => {
    const meetingTranscript = transcript({ title: "" });
    const matching = event("e1", {});
    const far = event("e2", {
      title: "Budget Review",
      startedAt: "2026-08-25T15:00:00.000Z",
      endedAt: "2026-08-25T16:00:00.000Z",
      participants: [{ email: "zoe@example.com" }],
    });

    const [meeting] = assembleMeetings({
      transcripts: [meetingTranscript],
      calendarEvents: [far, matching],
      mailMessages: [],
    });
    assert.isDefined(meeting);
    assert.strictEqual(meeting?.calendarEvent?.value, "event:e1");
    assert.isFalse(meeting?.needsConfirmation);
    // Title was empty on the transcript, so it comes from the event — with
    // the event recorded as its provenance.
    assert.strictEqual(meeting?.title.value, "Weekly Planning");
    assert.strictEqual(meeting?.title.from.sourceId, "event:e1");
    // Start time prefers the transcript (actual recording start).
    assert.strictEqual(meeting?.startedAt?.value, "2026-08-24T10:02:00.000Z");
    assert.strictEqual(meeting?.startedAt?.from.sourceId, "session:s1");
    // Participants merge without duplicates and cite both sources.
    assert.deepEqual(
      meeting?.participants.value.map((participant) => participant.email),
      ["ivan@example.com", "sam@example.com"],
    );
    assert.deepEqual(
      meeting?.participants.from.map((ref) => ref.sourceId),
      ["session:s1", "event:e1"],
    );
  });

  it("an explicit stored event link wins outright", () => {
    const linked = transcript({
      links: { meetingSessionId: "s1", calendarEventId: "e2" },
      title: "Completely different words",
      startedAt: "2026-08-20T08:00:00.000Z",
      endedAt: "2026-08-20T08:30:00.000Z",
      participants: [],
    });
    const [meeting] = assembleMeetings({
      transcripts: [linked],
      calendarEvents: [event("e1", {}), event("e2", { title: "Budget Review" })],
      mailMessages: [],
    });
    assert.strictEqual(meeting?.calendarEvent?.value, "event:e2");
    assert.strictEqual(meeting?.confidence, 1);
    assert.isFalse(meeting?.needsConfirmation);
  });

  it("marks near-tied candidates for confirmation instead of guessing", () => {
    // Two identical recurring instances at the same time — classic back-to-
    // back duplicate. No heuristic should silently pick one.
    const [meeting] = assembleMeetings({
      transcripts: [transcript({})],
      calendarEvents: [event("e1", {}), event("e1b", {})],
      mailMessages: [],
    });
    assert.isDefined(meeting);
    assert.isUndefined(meeting?.calendarEvent);
    assert.isTrue(meeting?.needsConfirmation);
    const ambiguity = meeting?.ambiguities[0];
    assert.strictEqual(ambiguity?.slot, "calendarEvent");
    assert.deepEqual(ambiguity?.candidates.map((candidate) => candidate.ref.sourceId).sort(), [
      "event:e1",
      "event:e1b",
    ]);
  });

  it("attaches nothing when no candidate clears the threshold", () => {
    const [meeting] = assembleMeetings({
      transcripts: [transcript({})],
      calendarEvents: [
        event("e9", {
          title: "Unrelated Sync",
          startedAt: "2026-08-28T09:00:00.000Z",
          endedAt: "2026-08-28T09:30:00.000Z",
          participants: [{ email: "nobody@example.com" }],
        }),
      ],
      mailMessages: [],
    });
    assert.isUndefined(meeting?.calendarEvent);
    assert.isFalse(meeting?.needsConfirmation);
    assert.strictEqual(meeting?.confidence, 0);
  });

  it("attaches a related mail thread within the time window", () => {
    const [meeting] = assembleMeetings({
      transcripts: [transcript({})],
      calendarEvents: [],
      mailMessages: [
        mail("m1", "t1", {}),
        mail("m2", "t1", { title: "Re: Weekly Planning agenda" }),
        mail("m3", "t2", {
          title: "Totally unrelated newsletter",
          participants: [{ email: "noreply@example.com" }],
        }),
      ],
    });
    assert.strictEqual(meeting?.mailThread?.threadId, "t1");
    assert.deepEqual(meeting?.mailThread?.messages.map((ref) => ref.sourceId).sort(), [
      "message:m1",
      "message:m2",
    ]);
  });

  it("carries the recurring series id from the matched event", () => {
    const [meeting] = assembleMeetings({
      transcripts: [transcript({})],
      calendarEvents: [
        event("e1", { links: { calendarEventId: "e1", recurringSeriesId: "series-7" } }),
      ],
      mailMessages: [],
    });
    assert.strictEqual(meeting?.recurringSeriesId, "series-7");
  });
});
