/**
 * Fixture meetings, hand-written.
 *
 * Everything else the panels render comes out of the seed scenario via
 * `fixtures.generated.ts`; meetings do not, because the seed does not carry
 * them yet. They live here rather than inline in `fixtures.ts` so the boundary
 * between generated and hand-written sample data stays visible, and so this
 * file can be deleted whole once the scenario grows a meetings section.
 *
 * The set exists to make every hole a recorded session really leaves
 * reachable in the UI: a fully diarized and timed session, one diarization
 * never attributed, a markdown fallback with neither timing nor a start time, a
 * session nobody took notes in, and one whose recording came back empty. Ids
 * match the `meetingId`s the generated calendar events already point at, so a
 * meeting opened from the calendar resolves.
 *
 * @module nomior/fixtures.meetings
 */
import type { MeetingParticipant } from "./types";

const IVAN: MeetingParticipant = { name: "Ivan Myshko", email: "ivan@nomior.example" };
/** Name, no address: the connector read this one off the meeting invite. */
const THEO: MeetingParticipant = { name: "Theo", email: null };
/** Address, no name: diarization heard a voice the directory could not name. */
const JULIUS: MeetingParticipant = { name: null, email: "julius@t3.example" };

export interface TurnScenario {
  readonly speaker: string | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly text: string;
}

export interface MeetingScenario {
  readonly id: string;
  readonly title: string;
  /** Days from Monday of the viewer's week. Null leaves the meeting undated. */
  readonly dayOffset: number | null;
  readonly startHour: number;
  readonly startMinute: number;
  readonly participants: readonly MeetingParticipant[];
  readonly calendarEventId: string | null;
  readonly notes: string | null;
  readonly turns: readonly TurnScenario[];
}

export const meetingScenarios: readonly MeetingScenario[] = [
  {
    id: "meet-review-engine-0825",
    title: "Review engine deep dive",
    dayOffset: 1,
    startHour: 14,
    startMinute: 0,
    participants: [IVAN, THEO, JULIUS],
    calendarEventId: "evt-review-engine-0825",
    notes: [
      "## Decisions",
      "",
      "- Board columns mirror the engine's states one to one: Queue, Reviewing, Waiting external, Approved, Not approved.",
      "- **Approved** and **Not approved** stay separate columns. Collapsing them into a single Done loses the verdict, which is the thing people open the board for.",
      "- Waiting external keeps its own column. A job blocked on a person is not a job in flight.",
      "",
      "## Open",
      "",
      "1. Who owns the arbiter pass when three legs disagree?",
      "2. The risk tier is on the card; the reason for the tier is not. Decide whether that needs a tooltip.",
      "",
      "Julius takes the arbiter question to Friday review.",
    ].join("\n"),
    turns: [
      {
        speaker: "Ivan",
        startMs: 0,
        endMs: 26_000,
        text: "The point of today is the review engine's state machine. I want the columns on the board to mean exactly what the engine means, not something adjacent to it.",
      },
      {
        speaker: "Theo",
        startMs: 27_500,
        endMs: 68_000,
        text: "Then the board cannot have a Done column. The engine has approved and not-approved, and those are two different outcomes, not two shades of finished.",
      },
      {
        speaker: "Theo",
        startMs: 68_500,
        endMs: 96_000,
        text: "If we collapse them, the user loses the one thing they came to the board to find out.",
      },
      {
        speaker: "Julius",
        startMs: 99_000,
        endMs: 141_000,
        text: "Agreed. What about waiting-external? Half the time we are blocked on a human reviewer rather than on the engine.",
      },
      {
        speaker: "Ivan",
        startMs: 144_000,
        endMs: 205_000,
        text: "That stays its own column. A job waiting on a person is not a job we are working, and pretending otherwise makes the queue look busier than it is.",
      },
      {
        speaker: "Julius",
        startMs: 209_000,
        endMs: 262_000,
        text: "Then the risk tier drives how many legs we run, and the tier goes on the card so nobody has to open a job to see why it took four reviewers.",
      },
      {
        speaker: "Theo",
        startMs: 268_000,
        endMs: 311_000,
        text: "One more. Manual review has to be requestable from the card. If I have to leave the board to ask for a human, I will not ask.",
      },
      {
        speaker: "Ivan",
        startMs: 314_000,
        endMs: 372_000,
        text: "Done. Blocker and major counts go on the card too. A card with two blockers should not look like a card with one minor finding.",
      },
      {
        speaker: "Julius",
        startMs: 376_000,
        endMs: 448_000,
        text: "Last thing from me: the verdict badge needs to survive a re-review. If a job flips from not-approved to approved, the card should say so rather than quietly changing color.",
      },
      {
        speaker: "Ivan",
        startMs: 452_000,
        endMs: 498_000,
        text: "Good catch. I will write that up on the issue before I start.",
      },
    ],
  },
  {
    id: "meet-recorder-0826",
    title: "Recorder pipeline",
    dayOffset: 2,
    startHour: 16,
    startMinute: 0,
    participants: [IVAN, THEO, JULIUS],
    calendarEventId: "evt-recorder-0826",
    notes: [
      "## Recorder",
      "",
      "Capture is local: the system audio tap plus the microphone, transcribed on this machine.",
      "",
      "- A failed transcription keeps the audio and a draft rather than dropping the session.",
      "- Diarization is best effort. Plenty of turns come back with no speaker, and the UI has to **say so** instead of guessing a name.",
      "- A draft carries no timing at all. Do not fabricate offsets for it.",
      "",
      "## Next",
      "",
      "1. Match meetings to calendar events on start time plus participant overlap.",
      "2. Decide what happens when the same session is ingested twice.",
    ].join("\n"),
    // Excerpted: a recording keeps every turn, the fixture keeps the ones that
    // read. The hour-long gap is where the working session sat.
    turns: [
      {
        speaker: "Ivan",
        startMs: 0,
        endMs: 34_000,
        text: "We tap the system output and the microphone as two streams, and mix them only after transcription.",
      },
      {
        speaker: null,
        startMs: 36_000,
        endMs: 71_000,
        text: "And it all stays on the machine. The audio never leaves it, and neither does the text.",
      },
      {
        speaker: "Ivan",
        startMs: 74_000,
        endMs: 118_000,
        text: "Two passes: a fast one while the meeting runs, a careful one after it ends. The second one replaces the first.",
      },
      {
        speaker: null,
        startMs: 121_000,
        endMs: 166_000,
        text: "What do we do about turns that come back with no speaker? Half of last week's recording looks like that.",
      },
      {
        speaker: null,
        startMs: 168_000,
        endMs: 214_000,
        text: "We say so on the block. Guessing a name is worse than leaving it unattributed, because a wrong name reads as a fact.",
      },
      {
        speaker: "Theo",
        startMs: 3_612_000,
        endMs: 3_660_000,
        text: "Last thing. The markdown fallback has no timestamps at all, so the reader drops the whole timestamp column rather than showing zeros down the page.",
      },
      {
        speaker: null,
        startMs: 3_664_000,
        endMs: 3_721_000,
        text: "And the meeting-to-event match is start time plus participant overlap. Title matching alone breaks on every recurring event.",
      },
      {
        speaker: "Ivan",
        startMs: 3_724_000,
        endMs: 3_768_000,
        text: "Good. That is the connector.",
      },
    ],
  },
  {
    id: "meet-standup-0827",
    title: "Daily standup",
    dayOffset: 3,
    startHour: 9,
    startMinute: 30,
    participants: [IVAN, THEO, JULIUS],
    calendarEventId: "evt-standup-0827",
    // Nobody writes notes in a standup.
    notes: null,
    turns: [
      {
        speaker: "Ivan",
        startMs: 0,
        endMs: 19_000,
        text: "Yesterday was the RPC contract for the panels. Today is wiring the live port. Nothing blocked.",
      },
      {
        speaker: "Theo",
        startMs: 21_000,
        endMs: 47_000,
        text: "I am on the desktop identity pass. Icons, product name, the about panel. It is mechanical and it will land today.",
      },
      {
        speaker: "Julius",
        startMs: 50_000,
        endMs: 83_000,
        text: "Reviewing 412 this morning. It is the high-risk one, so it gets three legs and an arbiter rather than a single pass.",
      },
      {
        speaker: "Ivan",
        startMs: 86_000,
        endMs: 112_000,
        text: "That is everything. Twelve minutes back.",
      },
    ],
  },
  {
    id: "meet-friday-0821",
    title: "Friday review",
    // The markdown fallback carries no metadata at all: no start time, no
    // timing, and nothing to match a calendar event on.
    dayOffset: null,
    startHour: 0,
    startMinute: 0,
    participants: [IVAN, THEO, JULIUS],
    calendarEventId: null,
    notes: [
      "Friday review — shipped this week",
      "",
      "- Review board landed behind the fixture port and renders standalone.",
      "- The calendar week grid stacks overlapping events; the agenda view is the honest one until it splits columns.",
      "- Instances panel: headroom comes from each provider's own rate-limit events, never from credentials.",
      "",
      "Nothing blocked. Next week is the meetings surface.",
    ].join("\n"),
    turns: [
      {
        speaker: "Ivan",
        startMs: null,
        endMs: null,
        text: "Quick pass over the week. The review board is in behind the fixture port, and every panel renders standalone.",
      },
      {
        speaker: "Theo",
        startMs: null,
        endMs: null,
        text: "The calendar week grid stacks overlapping events on top of each other. Until it splits columns, the agenda view is the one I would point people at.",
      },
      {
        speaker: "Ivan",
        startMs: null,
        endMs: null,
        text: "Agreed, and it is written into the port's doc comment so nobody has to rediscover it.",
      },
      {
        speaker: "Julius",
        startMs: null,
        endMs: null,
        text: "Instances is done. Headroom only comes from rate-limit events the provider sends us; we never look at credentials to guess it.",
      },
      {
        speaker: "Theo",
        startMs: null,
        endMs: null,
        text: "Then next week is meetings, which is the one people actually asked for.",
      },
    ],
  },
  {
    id: "meet-ep-master-0828",
    title: "Mix review — EP master",
    dayOffset: 4,
    startHour: 17,
    startMinute: 0,
    // A guest the directory knows nothing about, and one the connector heard
    // but could not identify at all.
    participants: [IVAN, { name: null, email: "mix@studio.example" }, { name: null, email: null }],
    calendarEventId: "evt-ep-master-0828",
    notes: [
      "## Mix review — EP master",
      "",
      "The recording never started, so this is typed from memory.",
      "",
      "- Track 3 needs 2 dB off the snare bus before it goes to mastering.",
      "- The vocal ride on track 5 is fighting the guitar. Automate it instead of compressing harder.",
      "- Sequencing stays as it is.",
    ].join("\n"),
    // Ingest ran and found nothing: the recording came back empty.
    turns: [],
  },
];
