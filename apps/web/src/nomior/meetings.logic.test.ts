import { describe, expect, it } from "vite-plus/test";

import {
  formatMeetingDay,
  formatMeetingDuration,
  formatMeetingStart,
  formatTurnOffset,
  groupTranscriptBySpeaker,
  orderMeetings,
  parseInlineEmphasis,
  parseNotesBlocks,
  participantInitials,
  participantLabel,
  participantSecondary,
  speakerLabel,
  summarizeParticipants,
  transcriptHasTiming,
  UNKNOWN_PARTICIPANT_LABEL,
  UNKNOWN_SPEAKER_LABEL,
} from "./meetings.logic";
import type { MeetingItem, TranscriptTurn } from "./types";

const turn = (overrides: Partial<TranscriptTurn> & { ordinal: number }): TranscriptTurn => ({
  id: `t${overrides.ordinal}`,
  speaker: "Ivan",
  startMs: overrides.ordinal * 10_000,
  endMs: overrides.ordinal * 10_000 + 8_000,
  text: "…",
  ...overrides,
});

const meeting = (overrides: Partial<MeetingItem>): MeetingItem => ({
  id: "meet-1",
  title: "Meeting",
  startedAt: "2026-08-25T14:00:00.000Z",
  durationMs: 600_000,
  participants: [],
  turnCount: 4,
  hasNotes: true,
  calendarEventId: null,
  ...overrides,
});

describe("formatTurnOffset", () => {
  it("renders mm:ss with a padded minute", () => {
    expect(formatTurnOffset(0)).toBe("00:00");
    expect(formatTurnOffset(9_000)).toBe("00:09");
    expect(formatTurnOffset(605_000)).toBe("10:05");
  });

  it("grows an hour field only past an hour", () => {
    expect(formatTurnOffset(3_599_000)).toBe("59:59");
    expect(formatTurnOffset(3_612_000)).toBe("1:00:12");
  });

  it("returns null for a turn with no timing rather than 00:00", () => {
    // The markdown fallback carries no offsets; a zero would claim the turn
    // happened at the very start of the recording.
    expect(formatTurnOffset(null)).toBeNull();
  });

  it("returns null for values that cannot be an offset", () => {
    expect(formatTurnOffset(-1)).toBeNull();
    expect(formatTurnOffset(Number.NaN)).toBeNull();
  });
});

describe("formatMeetingDuration", () => {
  it("says the length is unknown instead of showing zero", () => {
    expect(formatMeetingDuration(null)).toBe("Length unknown");
    expect(formatMeetingDuration(Number.NaN)).toBe("Length unknown");
  });

  it("keeps a sub-minute meeting from rounding to nothing", () => {
    expect(formatMeetingDuration(20_000)).toBe("Under a minute");
  });

  it("formats minutes and hours", () => {
    expect(formatMeetingDuration(480_000)).toBe("8 min");
    expect(formatMeetingDuration(3_600_000)).toBe("1 hr");
    expect(formatMeetingDuration(4_380_000)).toBe("1 hr 13 min");
  });
});

describe("formatMeetingStart", () => {
  it("names the missing start rather than rendering an epoch", () => {
    expect(formatMeetingStart(null, "en-US")).toBe("Date unknown");
    expect(formatMeetingDay(null, "en-US")).toBe("Date unknown");
  });

  it("falls back to the same label for an unparseable timestamp", () => {
    expect(formatMeetingStart("not a date", "en-US")).toBe("Date unknown");
  });

  it("renders a real start", () => {
    expect(formatMeetingStart("2026-08-25T14:00:00.000Z", "en-US")).toContain("2026");
    expect(formatMeetingDay("2026-08-25T14:00:00.000Z", "en-US")).toMatch(/Aug 2[56]/);
  });
});

describe("participant labels", () => {
  it("prefers the name, falls back to the email", () => {
    expect(participantLabel({ name: "Ivan Myshko", email: "ivan@nomior.example" })).toBe(
      "Ivan Myshko",
    );
    expect(participantLabel({ name: null, email: "julius@t3.example" })).toBe("julius@t3.example");
  });

  it("treats a blank name as no name", () => {
    expect(participantLabel({ name: "   ", email: "julius@t3.example" })).toBe("julius@t3.example");
  });

  it("says so when it knows neither", () => {
    expect(participantLabel({ name: null, email: null })).toBe(UNKNOWN_PARTICIPANT_LABEL);
    expect(participantInitials({ name: null, email: null })).toBe("?");
  });

  it("keeps the email as a secondary line only when it is not the label", () => {
    expect(participantSecondary({ name: "Ivan Myshko", email: "ivan@nomior.example" })).toBe(
      "ivan@nomior.example",
    );
    expect(participantSecondary({ name: null, email: "julius@t3.example" })).toBeNull();
    expect(participantSecondary({ name: "Theo", email: null })).toBeNull();
  });

  it("builds initials from names and from email local parts", () => {
    expect(participantInitials({ name: "Ivan Myshko", email: null })).toBe("IM");
    expect(participantInitials({ name: "Theo", email: null })).toBe("T");
    expect(participantInitials({ name: null, email: "julius@t3.example" })).toBe("JT");
  });
});

describe("summarizeParticipants", () => {
  it("names the empty room instead of rendering a blank line", () => {
    expect(summarizeParticipants([])).toBe("No participants recorded");
  });

  it("shows two and counts the rest", () => {
    const people = [
      { name: "Ivan Myshko", email: null },
      { name: "Theo", email: null },
      { name: null, email: "julius@t3.example" },
    ];
    expect(summarizeParticipants(people)).toBe("Ivan Myshko, Theo +1");
    expect(summarizeParticipants(people.slice(0, 2))).toBe("Ivan Myshko, Theo");
  });
});

describe("orderMeetings", () => {
  it("puts the newest first", () => {
    const older = meeting({ id: "older", startedAt: "2026-08-20T10:00:00.000Z" });
    const newer = meeting({ id: "newer", startedAt: "2026-08-27T10:00:00.000Z" });
    expect(orderMeetings([older, newer]).map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("sinks undated meetings below every dated one, in title order", () => {
    const dated = meeting({ id: "dated", startedAt: "2026-08-20T10:00:00.000Z" });
    const zulu = meeting({ id: "zulu", startedAt: null, title: "Zulu" });
    const alpha = meeting({ id: "alpha", startedAt: null, title: "Alpha" });
    expect(orderMeetings([zulu, dated, alpha]).map((entry) => entry.id)).toEqual([
      "dated",
      "alpha",
      "zulu",
    ]);
  });
});

describe("groupTranscriptBySpeaker", () => {
  it("merges consecutive turns from one speaker into a single block", () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ ordinal: 0, speaker: "Ivan" }),
      turn({ ordinal: 1, speaker: "Ivan" }),
      turn({ ordinal: 2, speaker: "Theo" }),
      turn({ ordinal: 3, speaker: "Ivan" }),
    ]);
    expect(blocks.map((block) => block.speaker)).toEqual(["Ivan", "Theo", "Ivan"]);
    expect(blocks[0]?.turns).toHaveLength(2);
  });

  it("sorts by ordinal before grouping", () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ ordinal: 2, speaker: "Ivan" }),
      turn({ ordinal: 0, speaker: "Ivan" }),
      turn({ ordinal: 1, speaker: "Theo" }),
    ]);
    expect(blocks.map((block) => block.speaker)).toEqual(["Ivan", "Theo", "Ivan"]);
  });

  it("never merges unattributed turns, not even with each other", () => {
    // Diarization named nobody. Joining two of these would claim one person
    // said both, which is a fact the transcript does not carry.
    const blocks = groupTranscriptBySpeaker([
      turn({ ordinal: 0, speaker: null }),
      turn({ ordinal: 1, speaker: null }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.speaker === null)).toBe(true);
  });

  it("spans a block's offsets across the turns it merged", () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ ordinal: 0, speaker: "Ivan", startMs: 1_000, endMs: 4_000 }),
      turn({ ordinal: 1, speaker: "Ivan", startMs: 5_000, endMs: 9_000 }),
    ]);
    expect(blocks[0]?.startMs).toBe(1_000);
    expect(blocks[0]?.endMs).toBe(9_000);
  });

  it("keeps a block untimed when its turns are, and borrows the first offset it finds", () => {
    const untimed = groupTranscriptBySpeaker([
      turn({ ordinal: 0, speaker: "Ivan", startMs: null, endMs: null }),
      turn({ ordinal: 1, speaker: "Ivan", startMs: null, endMs: null }),
    ]);
    expect(untimed[0]?.startMs).toBeNull();
    expect(untimed[0]?.endMs).toBeNull();

    const partial = groupTranscriptBySpeaker([
      turn({ ordinal: 0, speaker: "Ivan", startMs: null, endMs: null }),
      turn({ ordinal: 1, speaker: "Ivan", startMs: 6_000, endMs: 9_000 }),
    ]);
    expect(partial[0]?.startMs).toBe(6_000);
    expect(partial[0]?.endMs).toBe(9_000);
  });

  it("returns nothing for an empty transcript", () => {
    expect(groupTranscriptBySpeaker([])).toEqual([]);
  });
});

describe("transcriptHasTiming", () => {
  it("is false for the markdown fallback and for an empty transcript", () => {
    expect(transcriptHasTiming([turn({ ordinal: 0, startMs: null, endMs: null })])).toBe(false);
    expect(transcriptHasTiming([])).toBe(false);
  });

  it("is true as soon as one turn carries an offset", () => {
    expect(
      transcriptHasTiming([
        turn({ ordinal: 0, startMs: null, endMs: null }),
        turn({ ordinal: 1, startMs: 4_000, endMs: 6_000 }),
      ]),
    ).toBe(true);
  });
});

describe("speakerLabel", () => {
  it("names the unattributed turn", () => {
    expect(speakerLabel(null)).toBe(UNKNOWN_SPEAKER_LABEL);
    expect(speakerLabel("Ivan")).toBe("Ivan");
  });
});

describe("parseNotesBlocks", () => {
  it("splits headings, lists and paragraphs", () => {
    const blocks = parseNotesBlocks(
      [
        "## Decisions",
        "",
        "- Keep the columns",
        "- Split the verdict",
        "",
        "Julius follows up.",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Decisions" },
      { kind: "list", ordered: false, items: ["Keep the columns", "Split the verdict"] },
      { kind: "paragraph", text: "Julius follows up." },
    ]);
  });

  it("keeps ordered and unordered lists apart", () => {
    const blocks = parseNotesBlocks(["1. First", "2. Second", "- Aside"].join("\n"));
    expect(blocks).toEqual([
      { kind: "list", ordered: true, items: ["First", "Second"] },
      { kind: "list", ordered: false, items: ["Aside"] },
    ]);
  });

  it("joins wrapped lines into one paragraph and clamps deep headings", () => {
    const blocks = parseNotesBlocks(["##### Deep", "wrapped", "line"].join("\n"));
    expect(blocks).toEqual([
      { kind: "heading", level: 3, text: "Deep" },
      { kind: "paragraph", text: "wrapped line" },
    ]);
  });

  it("returns nothing for a whitespace-only document", () => {
    expect(parseNotesBlocks("\n \n")).toEqual([]);
  });
});

describe("parseInlineEmphasis", () => {
  it("pulls bold runs out and keeps the surrounding text", () => {
    expect(parseInlineEmphasis("keep **Approved** apart")).toEqual([
      { text: "keep ", strong: false },
      { text: "Approved", strong: true },
      { text: " apart", strong: false },
    ]);
  });

  it("leaves plain text as one segment", () => {
    expect(parseInlineEmphasis("plain")).toEqual([{ text: "plain", strong: false }]);
  });

  it("leaves an unclosed marker literal rather than eating the rest of the line", () => {
    expect(parseInlineEmphasis("half **open")).toEqual([{ text: "half **open", strong: false }]);
  });
});
