/**
 * Pure logic for the meetings panel: transcript grouping, offset and duration
 * formatting, participant labels, ordering, and the block split that lets the
 * notes read as a document instead of a wall of text.
 *
 * Every formatter here has to survive a hole the Anarlog connector really
 * leaves — a transcript with no timing, a turn diarization never attributed, a
 * participant with neither name nor email — so each one names the gap rather
 * than inventing a value. `00:00` on an untimed turn would be a lie.
 *
 * @module nomior/meetings.logic
 */
import type { MeetingItem, MeetingParticipant, TranscriptTurn } from "./types";

export const UNKNOWN_SPEAKER_LABEL = "Unattributed";
export const UNKNOWN_PARTICIPANT_LABEL = "Unknown participant";
export const UNKNOWN_DATE_LABEL = "Date unknown";
export const UNKNOWN_DURATION_LABEL = "Length unknown";

/**
 * A turn offset as `mm:ss`, or `h:mm:ss` once the meeting passes an hour.
 * Null in means null out: the caller decides what a missing offset looks like,
 * because a zero would read as "the very start of the recording".
 */
export function formatTurnOffset(offsetMs: number | null): string | null {
  if (offsetMs === null || !Number.isFinite(offsetMs) || offsetMs < 0) return null;
  const totalSeconds = Math.floor(offsetMs / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** Meeting length for the header. A null duration says so instead of `0m`. */
export function formatMeetingDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return UNKNOWN_DURATION_LABEL;
  }
  const totalMinutes = Math.round(durationMs / 60_000);
  if (totalMinutes < 1) return "Under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function formatStart(
  startedAt: string | null,
  options: Intl.DateTimeFormatOptions,
  locale: string | undefined,
): string {
  if (startedAt === null) return UNKNOWN_DATE_LABEL;
  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) return UNKNOWN_DATE_LABEL;
  return parsed.toLocaleString(locale, options);
}

/** Full start for the reading header. */
export function formatMeetingStart(startedAt: string | null, locale?: string): string {
  return formatStart(
    startedAt,
    { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
    locale,
  );
}

/** Compact start for a list row, where the column is narrow. */
export function formatMeetingDay(startedAt: string | null, locale?: string): string {
  return formatStart(startedAt, { month: "short", day: "numeric" }, locale);
}

/** The name when we have one, else the email, else an explicit unknown. */
export function participantLabel(participant: MeetingParticipant): string {
  const name = participant.name?.trim() ?? "";
  if (name.length > 0) return name;
  const email = participant.email?.trim() ?? "";
  if (email.length > 0) return email;
  return UNKNOWN_PARTICIPANT_LABEL;
}

/** The email, but only when it is not already carrying the label. */
export function participantSecondary(participant: MeetingParticipant): string | null {
  const email = participant.email?.trim() ?? "";
  if (email.length === 0 || email === participantLabel(participant)) return null;
  return email;
}

/** Up to two letters for an avatar chip; `?` when we do not know who this is. */
export function participantInitials(participant: MeetingParticipant): string {
  const label = participantLabel(participant);
  if (label === UNKNOWN_PARTICIPANT_LABEL) return "?";
  const words = label.split(/[\s._@-]+/).filter((word) => word.length > 0);
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/** The list row's one-line roster: two names, then a count for the rest. */
export function summarizeParticipants(
  participants: readonly MeetingParticipant[],
  shown = 2,
): string {
  if (participants.length === 0) return "No participants recorded";
  const labels = participants.slice(0, shown).map(participantLabel);
  const remaining = participants.length - labels.length;
  return remaining > 0 ? `${labels.join(", ")} +${remaining}` : labels.join(", ");
}

/**
 * Newest first. A meeting with no start time has no place on that timeline, so
 * it sinks below the dated ones and orders by title rather than pretending to
 * be either the newest or the oldest.
 */
export function orderMeetings(meetings: readonly MeetingItem[]): readonly MeetingItem[] {
  const dated = meetings.filter((meeting) => meeting.startedAt !== null);
  const undated = meetings.filter((meeting) => meeting.startedAt === null);
  return [
    ...dated.toSorted((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? "")),
    ...undated.toSorted((left, right) => left.title.localeCompare(right.title)),
  ];
}

export interface TranscriptBlock {
  /** The id of the turn that opened the block. */
  readonly id: string;
  readonly speaker: string | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly turns: readonly TranscriptTurn[];
}

/**
 * Consecutive turns from one speaker become a single block, so a transcript
 * stops repeating "Ivan:" down twelve lines.
 *
 * Unattributed turns never merge, not even with each other: diarization named
 * nobody, and joining two of them would claim one person said both. Block
 * offsets come from the first and last turn that carried timing, which leaves
 * them null for a transcript delivered without any.
 */
export function groupTranscriptBySpeaker(
  turns: readonly TranscriptTurn[],
): readonly TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const turn of turns.toSorted((left, right) => left.ordinal - right.ordinal)) {
    const open = blocks.at(-1);
    if (open !== undefined && turn.speaker !== null && open.speaker === turn.speaker) {
      blocks[blocks.length - 1] = {
        ...open,
        startMs: open.startMs ?? turn.startMs,
        endMs: turn.endMs ?? open.endMs,
        turns: [...open.turns, turn],
      };
      continue;
    }
    blocks.push({
      id: turn.id,
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs: turn.endMs,
      turns: [turn],
    });
  }
  return blocks;
}

/** False for the markdown fallback, which is how the reader knows to drop its timestamp gutter. */
export function transcriptHasTiming(turns: readonly TranscriptTurn[]): boolean {
  return turns.some((turn) => turn.startMs !== null);
}

export function speakerLabel(speaker: string | null): string {
  return speaker ?? UNKNOWN_SPEAKER_LABEL;
}

export type NotesBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Splits the connector's markdown-ish notes into the three shapes the reader
 * draws. Deliberately not a markdown parser: Anarlog writes headings, bullets
 * and paragraphs, and anything else survives as its own paragraph rather than
 * being swallowed by a rule that was guessing.
 */
export function parseNotesBlocks(notes: string): readonly NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const closeList = () => {
    if (list === null) return;
    blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const line of notes.split("\n")) {
    if (line.trim().length === 0) {
      closeParagraph();
      closeList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeParagraph();
      closeList();
      const level = Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2]?.trim() ?? "" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const item = bullet ?? NUMBERED.exec(line);
    if (item !== null) {
      closeParagraph();
      const ordered = bullet === null;
      if (list === null || list.ordered !== ordered) {
        closeList();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]?.trim() ?? "");
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  closeParagraph();
  closeList();
  return blocks;
}

export interface InlineSegment {
  readonly text: string;
  readonly strong: boolean;
}

/**
 * Pulls `**bold**` runs out of a line so notes do not render their own
 * asterisks. Every other marker stays literal — guessing at the rest of
 * markdown costs more than it buys on notes this short.
 */
export function parseInlineEmphasis(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), strong: false });
    segments.push({ text: match[1] ?? "", strong: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), strong: false });
  return segments.length === 0 ? [{ text, strong: false }] : segments;
}
