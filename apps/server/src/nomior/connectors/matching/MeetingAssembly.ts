/**
 * MeetingAssembly — merge a transcript, a calendar event, and (optionally)
 * a mail thread into one meeting entity.
 *
 * Matching is deliberately conservative: candidates are scored by
 * time-window overlap + title similarity + participant overlap, an exact
 * cross-store link (Anarlog's stored calendar event id) short-circuits to
 * a certain match, and when two candidates score within the ambiguity
 * margin the meeting is marked `needsConfirmation` with the candidates
 * listed instead of guessing. Every merged field carries provenance —
 * which source it came from.
 *
 * @module nomior/connectors/matching/MeetingAssembly
 */
import * as DateTime from "effect/DateTime";

import type { ConnectorParticipant, ConnectorSource } from "../Records.ts";

export interface SourceRef {
  readonly sourceId: string;
  readonly driverKind: string;
  readonly accountId: string;
}

export interface ProvenancedField<A> {
  readonly value: A;
  readonly from: SourceRef;
}

export interface MeetingCandidate {
  readonly ref: SourceRef;
  readonly score: number;
}

export interface MeetingAmbiguity {
  readonly slot: "calendarEvent" | "mailThread";
  readonly candidates: ReadonlyArray<MeetingCandidate>;
}

export interface AssembledMeeting {
  /** Stable id — the transcript's ref, or the event's for event-only meetings. */
  readonly meetingId: string;
  readonly title: ProvenancedField<string>;
  readonly startedAt?: ProvenancedField<string>;
  readonly endedAt?: ProvenancedField<string>;
  readonly participants: {
    readonly value: ReadonlyArray<ConnectorParticipant>;
    readonly from: ReadonlyArray<SourceRef>;
  };
  readonly transcript?: SourceRef;
  readonly calendarEvent?: ProvenancedField<string>;
  readonly recurringSeriesId?: string;
  readonly mailThread?: {
    readonly threadId: string;
    readonly messages: ReadonlyArray<SourceRef>;
  };
  /** Score of the weakest accepted attachment; 1 for a link-certain match. */
  readonly confidence: number;
  readonly needsConfirmation: boolean;
  readonly ambiguities: ReadonlyArray<MeetingAmbiguity>;
}

export interface MeetingAssemblyOptions {
  /** Minimum score to attach a candidate at all. */
  readonly acceptThreshold?: number;
  /** Best-vs-runner-up margin below which the slot is ambiguous. */
  readonly ambiguityMargin?: number;
  /** Max |transcript start − mail date| to consider a mail thread related. */
  readonly mailWindowMs?: number;
}

const DEFAULT_ACCEPT_THRESHOLD = 0.55;
const DEFAULT_AMBIGUITY_MARGIN = 0.1;
const DEFAULT_MAIL_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * Score assigned to an explicit cross-store link match. Deliberately above
 * the heuristic maximum (1) so a link-certain match can never tie with —
 * or be flagged ambiguous against — a heuristic candidate.
 */
const LINK_CERTAIN_SCORE = 2;

const toRef = (source: ConnectorSource): SourceRef => ({
  sourceId: source.sourceId,
  driverKind: source.provenance.driverKind,
  accountId: source.provenance.accountId,
});

const parseMs = (iso: string | undefined): number | undefined => {
  if (iso === undefined) {
    return undefined;
  }
  const parsed = DateTime.make(iso);
  return parsed._tag === "None" ? undefined : DateTime.toEpochMillis(parsed.value);
};

const tokenize = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );

/** Token Jaccard over normalized titles; 0 when either side is empty. */
export const titleSimilarity = (left: string, right: string): number => {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const participantKeys = (participants: ReadonlyArray<ConnectorParticipant>): Set<string> => {
  const keys = new Set<string>();
  for (const participant of participants) {
    if (participant.email !== undefined && participant.email !== "") {
      keys.add(participant.email.toLowerCase());
    } else if (participant.name !== undefined && participant.name !== "") {
      keys.add(`name:${participant.name.toLowerCase()}`);
    }
  }
  return keys;
};

/** Overlap over the smaller side, so a large invite list doesn't dilute. */
export const participantOverlap = (
  left: ReadonlyArray<ConnectorParticipant>,
  right: ReadonlyArray<ConnectorParticipant>,
): number => {
  const leftKeys = participantKeys(left);
  const rightKeys = participantKeys(right);
  if (leftKeys.size === 0 || rightKeys.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      intersection += 1;
    }
  }
  return intersection / Math.min(leftKeys.size, rightKeys.size);
};

/**
 * Interval overlap ratio over the shorter interval. Start-only sources
 * score by proximity (full credit within 5 minutes, fading to zero at an
 * hour) — meetings rarely start exactly on the calendar minute.
 */
export const timeOverlapScore = (
  left: { readonly startedAt?: string | undefined; readonly endedAt?: string | undefined },
  right: { readonly startedAt?: string | undefined; readonly endedAt?: string | undefined },
): number => {
  const leftStart = parseMs(left.startedAt);
  const rightStart = parseMs(right.startedAt);
  if (leftStart === undefined || rightStart === undefined) {
    return 0;
  }
  const leftEnd = parseMs(left.endedAt);
  const rightEnd = parseMs(right.endedAt);
  if (leftEnd !== undefined && rightEnd !== undefined) {
    const overlap = Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
    const shorter = Math.min(leftEnd - leftStart, rightEnd - rightStart);
    if (shorter <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, overlap / shorter));
  }
  const distance = Math.abs(leftStart - rightStart);
  const fullCreditMs = 5 * 60 * 1000;
  const zeroMs = 60 * 60 * 1000;
  if (distance <= fullCreditMs) {
    return 1;
  }
  if (distance >= zeroMs) {
    return 0;
  }
  return 1 - (distance - fullCreditMs) / (zeroMs - fullCreditMs);
};

export const scoreTranscriptAgainstEvent = (
  transcript: ConnectorSource,
  event: ConnectorSource,
): number => {
  // An explicit cross-store link (Anarlog stores the calendar event id it
  // recorded against) is certain — no heuristics needed.
  if (
    transcript.links.calendarEventId !== undefined &&
    (transcript.links.calendarEventId === event.links.calendarEventId ||
      transcript.links.calendarEventId === event.provenance.externalId)
  ) {
    return LINK_CERTAIN_SCORE;
  }
  return (
    0.5 * timeOverlapScore(transcript, event) +
    0.3 * titleSimilarity(transcript.title, event.title) +
    0.2 * participantOverlap(transcript.participants, event.participants)
  );
};

export const scoreTranscriptAgainstMail = (
  transcript: ConnectorSource,
  mail: ConnectorSource,
  mailWindowMs: number,
): number => {
  const transcriptStart = parseMs(transcript.startedAt);
  const mailDate = parseMs(mail.startedAt);
  const withinWindow =
    transcriptStart !== undefined &&
    mailDate !== undefined &&
    Math.abs(transcriptStart - mailDate) <= mailWindowMs;
  if (!withinWindow) {
    return 0;
  }
  return (
    0.6 * titleSimilarity(transcript.title, mail.title) +
    0.4 * participantOverlap(transcript.participants, mail.participants)
  );
};

interface SlotPick {
  readonly best: { readonly source: ConnectorSource; readonly score: number } | undefined;
  readonly ambiguity: MeetingAmbiguity | undefined;
}

const pickSlot = (
  slot: MeetingAmbiguity["slot"],
  scored: ReadonlyArray<{ readonly source: ConnectorSource; readonly score: number }>,
  acceptThreshold: number,
  ambiguityMargin: number,
): SlotPick => {
  const eligible = [...scored]
    .filter((candidate) => candidate.score >= acceptThreshold)
    .sort((a, b) => b.score - a.score);
  const best = eligible[0];
  if (best === undefined) {
    return { best: undefined, ambiguity: undefined };
  }
  const runnerUp = eligible[1];
  if (
    runnerUp !== undefined &&
    best.score < LINK_CERTAIN_SCORE &&
    best.score - runnerUp.score < ambiguityMargin
  ) {
    return {
      best: undefined,
      ambiguity: {
        slot,
        candidates: eligible.slice(0, 3).map((candidate) => ({
          ref: toRef(candidate.source),
          score: candidate.score,
        })),
      },
    };
  }
  return { best, ambiguity: undefined };
};

const dedupeParticipants = (
  groups: ReadonlyArray<ReadonlyArray<ConnectorParticipant>>,
): Array<ConnectorParticipant> => {
  const seen = new Set<string>();
  const merged: Array<ConnectorParticipant> = [];
  for (const group of groups) {
    for (const participant of group) {
      const key =
        participant.email !== undefined && participant.email !== ""
          ? participant.email.toLowerCase()
          : `name:${(participant.name ?? "").toLowerCase()}`;
      if (key === "name:" || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(participant);
    }
  }
  return merged;
};

export interface MeetingAssemblyInput {
  /** `meeting_transcript` sources (one per recorded meeting). */
  readonly transcripts: ReadonlyArray<ConnectorSource>;
  /** `calendar_event` sources. */
  readonly calendarEvents: ReadonlyArray<ConnectorSource>;
  /** `mail_message` sources. */
  readonly mailMessages: ReadonlyArray<ConnectorSource>;
}

/**
 * Assemble one meeting per transcript. Calendar events and mail threads
 * attach only when they clear the accept threshold unambiguously;
 * ambiguous slots surface their candidates for user confirmation.
 */
export const assembleMeetings = (
  input: MeetingAssemblyInput,
  options: MeetingAssemblyOptions = {},
): Array<AssembledMeeting> => {
  const acceptThreshold = options.acceptThreshold ?? DEFAULT_ACCEPT_THRESHOLD;
  const ambiguityMargin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  const mailWindowMs = options.mailWindowMs ?? DEFAULT_MAIL_WINDOW_MS;

  const mailByThread = new Map<string, Array<ConnectorSource>>();
  for (const mail of input.mailMessages) {
    const threadId = mail.links.mailThreadId;
    if (threadId === undefined) {
      continue;
    }
    const existing = mailByThread.get(threadId);
    if (existing === undefined) {
      mailByThread.set(threadId, [mail]);
    } else {
      existing.push(mail);
    }
  }

  return input.transcripts.map((transcript) => {
    const transcriptRef = toRef(transcript);

    const eventPick = pickSlot(
      "calendarEvent",
      input.calendarEvents.map((event) => ({
        source: event,
        score: scoreTranscriptAgainstEvent(transcript, event),
      })),
      acceptThreshold,
      ambiguityMargin,
    );

    const threadScores = [...mailByThread.entries()].map(([threadId, messages]) => {
      const bestMessage = messages.reduce(
        (best, message) => {
          const score = scoreTranscriptAgainstMail(transcript, message, mailWindowMs);
          return score > best.score ? { message, score } : best;
        },
        { message: messages[0] as ConnectorSource, score: -1 },
      );
      return { threadId, messages, source: bestMessage.message, score: bestMessage.score };
    });
    const mailPick = pickSlot(
      "mailThread",
      threadScores.map(({ source, score }) => ({ source, score })),
      acceptThreshold,
      ambiguityMargin,
    );
    const pickedThread =
      mailPick.best === undefined
        ? undefined
        : threadScores.find((thread) => thread.source.sourceId === mailPick.best?.source.sourceId);

    const event = eventPick.best?.source;

    const title =
      transcript.title !== ""
        ? { value: transcript.title, from: transcriptRef }
        : event !== undefined && event.title !== ""
          ? { value: event.title, from: toRef(event) }
          : { value: transcript.title, from: transcriptRef };

    const startedAt =
      transcript.startedAt !== undefined
        ? { value: transcript.startedAt, from: transcriptRef }
        : event?.startedAt !== undefined
          ? { value: event.startedAt, from: toRef(event) }
          : undefined;
    const endedAt =
      transcript.endedAt !== undefined
        ? { value: transcript.endedAt, from: transcriptRef }
        : event?.endedAt !== undefined
          ? { value: event.endedAt, from: toRef(event) }
          : undefined;

    const participantSources: Array<SourceRef> = [transcriptRef];
    const participantGroups: Array<ReadonlyArray<ConnectorParticipant>> = [transcript.participants];
    if (event !== undefined) {
      participantSources.push(toRef(event));
      participantGroups.push(event.participants);
    }

    const ambiguities = [
      ...(eventPick.ambiguity === undefined ? [] : [eventPick.ambiguity]),
      ...(mailPick.ambiguity === undefined ? [] : [mailPick.ambiguity]),
    ];

    const attachedScores = [
      ...(eventPick.best === undefined ? [] : [eventPick.best.score]),
      ...(mailPick.best === undefined ? [] : [mailPick.best.score]),
    ];

    const recurringSeriesId = event?.links.recurringSeriesId ?? transcript.links.recurringSeriesId;

    return {
      meetingId: `meeting:${transcript.provenance.driverKind}:${transcript.provenance.accountId}:${transcript.sourceId}`,
      title,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      participants: {
        value: dedupeParticipants(participantGroups),
        from: participantSources,
      },
      transcript: transcriptRef,
      ...(event === undefined
        ? {}
        : { calendarEvent: { value: event.sourceId, from: toRef(event) } }),
      ...(recurringSeriesId === undefined ? {} : { recurringSeriesId }),
      ...(pickedThread === undefined
        ? {}
        : {
            mailThread: {
              threadId: pickedThread.threadId,
              messages: pickedThread.messages.map(toRef),
            },
          }),
      confidence: attachedScores.length === 0 ? 0 : Math.min(1, ...attachedScores),
      needsConfirmation: ambiguities.length > 0,
      ambiguities,
    } satisfies AssembledMeeting;
  });
};
