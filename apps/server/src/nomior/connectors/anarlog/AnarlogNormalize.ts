/**
 * Pure normalization from Anarlog rows to connector records.
 *
 * A meeting session becomes one `meeting_transcript` source whose chunks
 * are speaker turns (speaker label + millisecond offsets preserved); each
 * session document becomes a separate `meeting_notes` source linked back
 * to the meeting via `links.meetingSessionId`.
 *
 * @module nomior/connectors/anarlog/AnarlogNormalize
 */
import * as DateTime from "effect/DateTime";

import type {
  ConnectorAccountId,
  ConnectorChunk,
  ConnectorDriverKind,
  ConnectorParticipant,
  ConnectorRecord,
  ConnectorSource,
} from "../Records.ts";
import type { AnarlogSessionBundle, AnarlogSpeakerIdentity, AnarlogWord } from "./AnarlogSchema.ts";

/** Split a speaker turn after this many words to bound chunk size. */
const MAX_WORDS_PER_CHUNK = 120;

const speakerLabel = (speaker: AnarlogSpeakerIdentity | null | undefined): string | undefined => {
  if (speaker === null || speaker === undefined) {
    return undefined;
  }
  switch (speaker.type) {
    case "assigned":
      return speaker.value.label;
    case "unassigned":
      return `Speaker ${speaker.value.index + 1}`;
  }
};

const parseEpochMs = (iso: string): number | undefined => {
  if (iso === "") {
    return undefined;
  }
  const parsed = DateTime.make(iso);
  return parsed._tag === "None" ? undefined : DateTime.toEpochMillis(parsed.value);
};

interface SpeakerTurn {
  readonly speaker: string | undefined;
  readonly words: Array<AnarlogWord>;
}

const groupIntoTurns = (words: ReadonlyArray<AnarlogWord>): Array<SpeakerTurn> => {
  const turns: Array<SpeakerTurn> = [];
  for (const word of words) {
    const label = speakerLabel(word.speaker);
    const current = turns.at(-1);
    if (
      current !== undefined &&
      current.speaker === label &&
      current.words.length < MAX_WORDS_PER_CHUNK
    ) {
      current.words.push(word);
    } else {
      turns.push({ speaker: label, words: [word] });
    }
  }
  return turns;
};

/**
 * Extract plain text from a ProseMirror document JSON string. Collects
 * `text` leaves, joining block-level nodes with newlines. Returns the raw
 * input when it is not parseable ProseMirror JSON — degraded but never
 * silently empty.
 */
export const proseMirrorToPlainText = (body: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const blocks: Array<string> = [];
  const collectInline = (node: unknown): string => {
    if (typeof node !== "object" || node === null) {
      return "";
    }
    const record = node as { readonly text?: unknown; readonly content?: unknown };
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      return record.content.map(collectInline).join("");
    }
    return "";
  };
  const collectBlocks = (node: unknown): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    const record = node as { readonly type?: unknown; readonly content?: unknown };
    if (!Array.isArray(record.content)) {
      return;
    }
    const hasNestedBlocks = record.content.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        Array.isArray((child as { readonly content?: unknown }).content),
    );
    if (hasNestedBlocks) {
      for (const child of record.content) {
        collectBlocks(child);
      }
      return;
    }
    const text = record.content.map(collectInline).join("");
    if (text.trim() !== "") {
      blocks.push(text);
    }
  };
  collectBlocks(parsed);
  return blocks.length === 0 ? body : blocks.join("\n");
};

export const documentBodyToPlainText = (bodyFormat: string, body: string): string =>
  bodyFormat === "prosemirror_json" ? proseMirrorToPlainText(body) : body;

export interface AnarlogNormalizeContext {
  readonly driverKind: ConnectorDriverKind;
  readonly accountId: ConnectorAccountId;
}

/**
 * Normalize one session bundle into records: exactly one
 * `meeting_transcript` source (even when the transcript is empty, so the
 * meeting itself is retrievable) plus one `meeting_notes` source per
 * document.
 */
export const normalizeSessionBundle = (
  context: AnarlogNormalizeContext,
  bundle: AnarlogSessionBundle,
): Array<ConnectorRecord> => {
  const { session, transcripts, documents, participants } = bundle;

  const normalizedParticipants: Array<ConnectorParticipant> = participants.map((row) => ({
    ...(row.displayName === "" ? {} : { name: row.displayName }),
    ...(row.email === "" ? {} : { email: row.email }),
  }));

  const transcriptEpochs = transcripts
    .map((transcript) => transcript.startedAtMs)
    .filter((ms) => ms > 0);
  const sessionStartEpochMs =
    parseEpochMs(session.startedAt) ??
    (transcriptEpochs.length > 0 ? Math.min(...transcriptEpochs) : undefined);
  const startedAtIso =
    session.startedAt !== ""
      ? session.startedAt
      : sessionStartEpochMs !== undefined
        ? DateTime.formatIso(DateTime.makeUnsafe(sessionStartEpochMs))
        : undefined;

  const links = {
    meetingSessionId: session.id,
    ...(session.externalEventId !== ""
      ? { calendarEventId: session.externalEventId }
      : session.eventId !== ""
        ? { calendarEventId: session.eventId }
        : {}),
    ...(session.seriesId === "" ? {} : { recurringSeriesId: session.seriesId }),
  };

  const meetingSourceId = `session:${session.id}`;
  const meetingSource: ConnectorSource = {
    sourceId: meetingSourceId,
    kind: "meeting_transcript",
    title: session.title,
    ...(startedAtIso === undefined ? {} : { startedAt: startedAtIso }),
    ...(session.endedAt === "" ? {} : { endedAt: session.endedAt }),
    participants: normalizedParticipants,
    links,
    provenance: {
      driverKind: context.driverKind,
      accountId: context.accountId,
      externalId: session.id,
      externalUpdatedAt: session.effectiveUpdatedAt,
    },
  };

  const chunks: Array<ConnectorChunk> = [];
  for (const transcript of transcripts) {
    const transcriptOffsetMs =
      sessionStartEpochMs !== undefined && transcript.startedAtMs > 0
        ? transcript.startedAtMs - sessionStartEpochMs
        : 0;
    for (const turn of groupIntoTurns(transcript.words)) {
      const text = turn.words
        .map((word) => word.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text === "") {
        continue;
      }
      const firstStart = turn.words[0]?.start_ms;
      const lastEnd = turn.words.at(-1)?.end_ms;
      const index = chunks.length;
      chunks.push({
        chunkId: `${meetingSourceId}/chunk/${index}`,
        sourceId: meetingSourceId,
        index,
        text,
        ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
        ...(firstStart === null || firstStart === undefined
          ? {}
          : { startMs: transcriptOffsetMs + firstStart }),
        ...(lastEnd === null || lastEnd === undefined
          ? {}
          : { endMs: transcriptOffsetMs + lastEnd }),
      });
    }
  }

  const records: Array<ConnectorRecord> = [{ source: meetingSource, chunks }];

  for (const document of documents) {
    const noteSourceId = `session:${session.id}/note:${document.id}`;
    const text = documentBodyToPlainText(document.bodyFormat, document.body);
    const noteSource: ConnectorSource = {
      sourceId: noteSourceId,
      kind: "meeting_notes",
      title: document.title === "" ? session.title : document.title,
      ...(startedAtIso === undefined ? {} : { startedAt: startedAtIso }),
      participants: normalizedParticipants,
      links,
      provenance: {
        driverKind: context.driverKind,
        accountId: context.accountId,
        externalId: document.id,
        externalUpdatedAt: document.updatedAt,
      },
    };
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== "");
    records.push({
      source: noteSource,
      chunks: paragraphs.map((paragraph, index) => ({
        chunkId: `${noteSourceId}/chunk/${index}`,
        sourceId: noteSourceId,
        index,
        text: paragraph,
      })),
    });
  }

  return records;
};
