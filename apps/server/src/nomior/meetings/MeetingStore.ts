/**
 * MeetingStore — the meetings panel's read model over the context broker.
 *
 * A meeting is not a table. The Anarlog connector ingests one `meeting_transcript`
 * record as a `nomior_sources` row of kind `meeting`, its speaker turns as that
 * source's `nomior_chunks`, and each set of human notes as a *separate* source of
 * kind `document`. Only `provenance_json` ties the two together, so every query
 * here filters on `$.connectorKind` and joins on `$.links.meetingSessionId` —
 * the keys `ContextIngestAdapter` writes. A source whose provenance lacks them
 * is not a connector meeting and never appears.
 *
 * Two things the broker does not store, derived here rather than invented:
 *
 * - **Duration.** `endedAt` exists on the connector record and is dropped at
 *   ingest. `ts_end` is seconds from the start of the recording, so the largest
 *   one across a meeting's turns is its length. Null when no turn carries timing
 *   (the connector's markdown fallback has none).
 * - **Notes.** The notes body is the joined document's chunks in `ordinal`
 *   order, concatenated with the same blank line `planChunks` renders between
 *   segments.
 *
 * A chunk is a retrieval unit that happens to align with a speaker turn:
 * `planChunks` merges consecutive segments up to 1200 characters but stops at
 * every speaker change, so a chunk never spans two speakers. Turns from one
 * speaker in a row still arrive merged, which is what the panel wants anyway.
 *
 * @module nomior/meetings/MeetingStore
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * Hard ceiling on the turns one `getMeeting` returns. Chunks cap at 1200
 * characters, so this is a ~2.4 MB worst case on the wire; a real 90-minute
 * meeting is around 70 chunks, and 2000 would be a two-day recording. It exists
 * so a corrupt or synthetic source cannot push an unbounded payload through the
 * WebSocket, not as a paging boundary.
 */
export const MAX_TRANSCRIPT_TURNS = 2000;

/** The blank line `planChunks` renders between segments of one source. */
const CHUNK_SEPARATOR = "\n\n";

export class MeetingNotFoundError extends Schema.TaggedErrorClass<MeetingNotFoundError>()(
  "NomiorMeetingNotFoundError",
  { id: Schema.String },
) {}

export interface MeetingParticipant {
  readonly name: string | null;
  readonly email: string | null;
}

export interface StoredMeeting {
  readonly id: string;
  readonly title: string;
  /** The connector's start time; null for a session that never recorded one. */
  readonly startedAt: string | null;
  /** Milliseconds to the last timed turn; null when no turn carries timing. */
  readonly durationMs: number | null;
  readonly participants: ReadonlyArray<MeetingParticipant>;
  readonly turnCount: number;
  readonly hasNotes: boolean;
  readonly calendarEventId: string | null;
}

export interface StoredTranscriptTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly speaker: string | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly text: string;
}

export interface StoredMeetingDetail {
  readonly meeting: StoredMeeting;
  readonly transcript: ReadonlyArray<StoredTranscriptTurn>;
  readonly notes: string | null;
}

/** Half-open on the start, optional on both ends; omitted means unbounded. */
export interface MeetingWindow {
  readonly rangeStart?: string | undefined;
  readonly rangeEnd?: string | undefined;
}

export class MeetingStore extends Context.Service<
  MeetingStore,
  {
    /** Meetings newest first, with the counts the list renders. */
    readonly listMeetings: (
      window: MeetingWindow,
    ) => Effect.Effect<ReadonlyArray<StoredMeeting>, PersistenceSqlError>;
    /** One meeting with its transcript and joined notes. */
    readonly getMeeting: (
      id: string,
    ) => Effect.Effect<StoredMeetingDetail, PersistenceSqlError | MeetingNotFoundError>;
  }
>()("t3/nomior/meetings/MeetingStore") {}

/** A stored row that no longer decodes is a persistence fault, not a caller error. */
const toStoreError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? new PersistenceSqlError({
        operation,
        detail: "stored meeting row does not match the expected shape",
        cause,
      })
    : toPersistenceSqlError(operation)(cause);

const BooleanFromInt = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (stored: number) => stored !== 0,
      encode: (value: boolean): number => (value ? 1 : 0),
    }),
  ),
);

const MeetingSummaryRow = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  startedAt: Schema.NullOr(IsoDateTime),
  /** Anarlog's session id, the key the notes document is joined on. */
  sessionId: Schema.NullOr(Schema.String),
  calendarEventId: Schema.NullOr(Schema.String),
  /** The raw `$.participants` array, still JSON text (see `parseParticipants`). */
  participantsJson: Schema.NullOr(Schema.String),
  turnCount: Schema.Int,
  /** Seconds from the start of the recording to its last timed turn. */
  durationSeconds: Schema.NullOr(Schema.Number),
  hasNotes: BooleanFromInt,
});

const TranscriptTurnRow = Schema.Struct({
  id: TrimmedNonEmptyString,
  ordinal: Schema.Int,
  speaker: Schema.NullOr(Schema.String),
  tsStart: Schema.NullOr(Schema.Number),
  tsEnd: Schema.NullOr(Schema.Number),
  text: Schema.String,
});

const NotesChunkRow = Schema.Struct({ text: Schema.String });

/** Unparseable JSON and a non-array both come back as `None`. */
const decodeProvenanceArray = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * `provenance_json` is a free-form blob each driver writes for itself, so a
 * participants array in an unexpected shape must cost that meeting its
 * attendee chips, never the whole list. Entries carrying neither a name nor an
 * email are dropped: they would render as an empty chip.
 */
export const parseParticipants = (raw: string | null): ReadonlyArray<MeetingParticipant> => {
  if (raw === null) return [];
  const parsed = decodeProvenanceArray(raw);
  if (Option.isNone(parsed)) return [];
  const participants: Array<MeetingParticipant> = [];
  for (const entry of parsed.value) {
    if (!isRecord(entry)) continue;
    const name = stringOrNull(entry.name);
    const email = stringOrNull(entry.email);
    if (name === null && email === null) continue;
    participants.push({ name, email });
  }
  return participants;
};

const secondsToMs = (seconds: number | null): number | null =>
  seconds === null ? null : Math.round(seconds * 1000);

const toStoredMeeting = (row: typeof MeetingSummaryRow.Type): StoredMeeting => ({
  id: row.id,
  title: row.title,
  startedAt: row.startedAt,
  durationMs: secondsToMs(row.durationSeconds),
  participants: parseParticipants(row.participantsJson),
  turnCount: row.turnCount,
  hasNotes: row.hasNotes,
  calendarEventId: row.calendarEventId,
});

/**
 * Drop the `"Ivan: "` label the chunker renders into the text.
 *
 * `renderSegment` prefixes every spoken segment with its speaker, and that
 * prefix is load-bearing downstream — it is part of the canonical text the
 * evidence spans address and part of what FTS matches on. It is only redundant
 * here, where the panel already renders `speaker` as its own field and would
 * otherwise print the name twice.
 *
 * Exact, not heuristic: this removes the one literal the chunker prepended,
 * per merged segment, and leaves a line alone when it does not carry it.
 */
const stripSpeakerPrefix = (text: string, speaker: string | null): string => {
  if (speaker === null) return text;
  const prefix = `${speaker}: `;
  return text
    .split(CHUNK_SEPARATOR)
    .map((part) => (part.startsWith(prefix) ? part.slice(prefix.length) : part))
    .join(CHUNK_SEPARATOR);
};

const toStoredTurn = (row: typeof TranscriptTurnRow.Type): StoredTranscriptTurn => ({
  id: row.id,
  ordinal: row.ordinal,
  speaker: row.speaker,
  startMs: secondsToMs(row.tsStart),
  endMs: secondsToMs(row.tsEnd),
  text: stripSpeakerPrefix(row.text, row.speaker),
});

/**
 * The summary columns, shared by the list and the detail so the two can never
 * disagree about what a meeting is. `CAST(... AS TEXT)` keeps a driver that
 * wrote a number where a string belongs from failing the row's decode.
 * Aggregates run in SQL: a long meeting is thousands of chunks.
 */
const SUMMARY_COLUMNS = `
  s.id AS "id",
  s.title AS "title",
  s.occurred_at AS "startedAt",
  CAST(json_extract(s.provenance_json, '$.links.meetingSessionId') AS TEXT) AS "sessionId",
  CAST(json_extract(s.provenance_json, '$.links.calendarEventId') AS TEXT) AS "calendarEventId",
  CAST(json_extract(s.provenance_json, '$.participants') AS TEXT) AS "participantsJson",
  (SELECT COUNT(*) FROM nomior_chunks c WHERE c.source_id = s.id) AS "turnCount",
  (SELECT MAX(c.ts_end) FROM nomior_chunks c WHERE c.source_id = s.id) AS "durationSeconds",
  EXISTS (
    SELECT 1 FROM nomior_sources n
    WHERE n.kind = 'document'
      AND json_extract(n.provenance_json, '$.connectorKind') = 'meeting_notes'
      AND json_extract(n.provenance_json, '$.links.meetingSessionId')
          = json_extract(s.provenance_json, '$.links.meetingSessionId')
      AND json_extract(s.provenance_json, '$.links.meetingSessionId') IS NOT NULL
  ) AS "hasNotes"
`;

const IS_MEETING = `
  s.kind = 'meeting'
  AND json_extract(s.provenance_json, '$.connectorKind') = 'meeting_transcript'
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({
      rangeStart: Schema.NullOr(IsoDateTime),
      rangeEnd: Schema.NullOr(IsoDateTime),
    }),
    Result: MeetingSummaryRow,
    // Timestamps compare as strings, which is only correct because everything
    // that reaches `occurred_at` is UTC ISO-8601. A meeting with no start is
    // outside every bounded window: `NULL >= x` is not true.
    execute: ({ rangeStart, rangeEnd }) =>
      sql`
        SELECT ${sql.literal(SUMMARY_COLUMNS)}
        FROM nomior_sources s
        WHERE ${sql.literal(IS_MEETING)}
          ${rangeStart === null ? sql`` : sql`AND s.occurred_at >= ${rangeStart}`}
          ${rangeEnd === null ? sql`` : sql`AND s.occurred_at < ${rangeEnd}`}
        ORDER BY s.occurred_at DESC, s.id ASC
      `,
  });

  const findSummary = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.String }),
    Result: MeetingSummaryRow,
    execute: ({ id }) =>
      sql`
        SELECT ${sql.literal(SUMMARY_COLUMNS)}
        FROM nomior_sources s
        WHERE ${sql.literal(IS_MEETING)} AND s.id = ${id}
      `,
  });

  const findTurns = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.String }),
    Result: TranscriptTurnRow,
    execute: ({ id }) =>
      sql`
        SELECT
          c.id AS "id",
          c.ordinal AS "ordinal",
          c.speaker AS "speaker",
          c.ts_start AS "tsStart",
          c.ts_end AS "tsEnd",
          c.text AS "text"
        FROM nomior_chunks c
        WHERE c.source_id = ${id}
        ORDER BY c.ordinal ASC
        LIMIT ${MAX_TRANSCRIPT_TURNS}
      `,
  });

  /**
   * Anarlog emits one notes document per session document, so a session can
   * have several. They concatenate in `external_id` order — the document's own
   * id, which is stable across re-syncs where the broker's row id is not.
   */
  const findNotesChunks = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String }),
    Result: NotesChunkRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT c.text AS "text"
        FROM nomior_chunks c
        JOIN nomior_sources n ON n.id = c.source_id
        WHERE n.kind = 'document'
          AND json_extract(n.provenance_json, '$.connectorKind') = 'meeting_notes'
          AND json_extract(n.provenance_json, '$.links.meetingSessionId') = ${sessionId}
        ORDER BY n.external_id ASC, n.id ASC, c.ordinal ASC
        LIMIT ${MAX_TRANSCRIPT_TURNS}
      `,
  });

  const getMeeting = Effect.fn("MeetingStore.getMeeting")(function* (id: string) {
    const summaries = yield* findSummary({ id }).pipe(
      Effect.mapError(toStoreError("meetings.getMeeting")),
    );
    const summary = summaries[0];
    if (summary === undefined) {
      return yield* new MeetingNotFoundError({ id });
    }
    const turns = yield* findTurns({ id }).pipe(
      Effect.mapError(toStoreError("meetings.getMeeting:transcript")),
    );
    const notesChunks =
      summary.sessionId === null
        ? []
        : yield* findNotesChunks({ sessionId: summary.sessionId }).pipe(
            Effect.mapError(toStoreError("meetings.getMeeting:notes")),
          );
    return {
      meeting: toStoredMeeting(summary),
      transcript: turns.map(toStoredTurn),
      notes:
        notesChunks.length === 0
          ? null
          : notesChunks.map((chunk) => chunk.text).join(CHUNK_SEPARATOR),
    } satisfies StoredMeetingDetail;
  });

  return MeetingStore.of({
    listMeetings: (window) =>
      listRows({
        rangeStart: window.rangeStart ?? null,
        rangeEnd: window.rangeEnd ?? null,
      }).pipe(
        Effect.map((rows) => rows.map(toStoredMeeting)),
        Effect.mapError(toStoreError("meetings.listMeetings")),
        Effect.withSpan("MeetingStore.listMeetings"),
      ),
    getMeeting,
  });
});

export const layer = Layer.effect(MeetingStore, make);
