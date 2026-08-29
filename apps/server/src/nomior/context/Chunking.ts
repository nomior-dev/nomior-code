/**
 * Chunking - pure normalization of a source into evidence-addressable chunks.
 *
 * A source's segments (speaker turns, paragraphs) are rendered into one
 * canonical text; every chunk records the exact character range it occupies in
 * that canonical text, so `canonicalText.slice(charStart, charEnd) ===
 * chunk.text` always holds. That range is the evidence span citations point
 * at.
 *
 * Boundary rule: a chunk boundary never falls inside a segment. The one
 * exception is a single segment longer than `maxChars`, which becomes its own
 * run of chunks split at sentence boundaries — each piece keeps the segment's
 * speaker and timestamps.
 *
 * @module Chunking
 */
import type { NomiorSourceKind, SourceSegment } from "./Model.ts";

export const DEFAULT_MAX_CHUNK_CHARS = 1200;

export interface PlannedChunk {
  readonly ordinal: number;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  /** Set when every segment in the chunk shares one speaker. */
  readonly speaker: string | null;
  readonly tsStart: number | null;
  readonly tsEnd: number | null;
  readonly section: string | null;
}

export interface ChunkPlan {
  readonly canonicalText: string;
  readonly chunks: ReadonlyArray<PlannedChunk>;
}

export interface ChunkSourceMeta {
  readonly kind: NomiorSourceKind;
  readonly title: string;
  readonly occurredAt?: string | undefined;
}

const SEGMENT_SEPARATOR = "\n\n";

/** How a segment appears in the canonical text (speaker label included). */
export const renderSegment = (segment: SourceSegment): string =>
  segment.speaker === undefined ? segment.text : `${segment.speaker}: ${segment.text}`;

interface RenderedPiece {
  readonly text: string;
  readonly speaker: string | null;
  readonly section: string | null;
  readonly tsStart: number | null;
  readonly tsEnd: number | null;
}

const splitSentences = (text: string): ReadonlyArray<string> =>
  text.split(/(?<=[.!?…])\s+/u).filter((sentence) => sentence.length > 0);

const hardSplit = (text: string, maxChars: number): ReadonlyArray<string> => {
  const pieces: Array<string> = [];
  for (let index = 0; index < text.length; index += maxChars) {
    pieces.push(text.slice(index, index + maxChars));
  }
  return pieces;
};

/** Split one oversized rendered segment at sentence boundaries into ≤ maxChars pieces. */
const splitOversized = (text: string, maxChars: number): ReadonlyArray<string> => {
  const pieces: Array<string> = [];
  let current = "";
  for (const sentence of splitSentences(text)) {
    const parts = sentence.length > maxChars ? hardSplit(sentence, maxChars) : [sentence];
    for (const part of parts) {
      if (current.length === 0) {
        current = part;
      } else if (current.length + 1 + part.length <= maxChars) {
        current = `${current} ${part}`;
      } else {
        pieces.push(current);
        current = part;
      }
    }
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
};

const formatSeconds = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

/**
 * Deterministic contextual prefix: source title, kind, date, section or time
 * range, speaker. Cheap, offline, and stable across re-ingests.
 *
 * Seam: Anthropic-style contextual retrieval replaces this with an
 * LLM-generated situating sentence. That lands as an alternative
 * `ContextualPrefixer` layer (see Ingest.ts) — same signature, richer output —
 * so nothing else changes.
 */
export const computeContextualPrefix = (
  source: ChunkSourceMeta,
  chunk: Pick<PlannedChunk, "speaker" | "tsStart" | "tsEnd" | "section">,
): string => {
  const parts: Array<string> = [source.title, source.kind];
  const date = source.occurredAt?.slice(0, 10);
  if (date !== undefined && date.length > 0) {
    parts.push(date);
  }
  if (chunk.section !== null) {
    parts.push(chunk.section);
  } else if (chunk.tsStart !== null) {
    parts.push(
      chunk.tsEnd !== null
        ? `${formatSeconds(chunk.tsStart)}–${formatSeconds(chunk.tsEnd)}`
        : formatSeconds(chunk.tsStart),
    );
  }
  if (chunk.speaker !== null) {
    parts.push(chunk.speaker);
  }
  return parts.join(" · ");
};

/**
 * Plan chunks for a source. Pure: no ids, no IO. The ingest service assigns
 * chunk ids from ordinals, attaches contextual prefixes (see
 * `ContextualPrefixer` in Ingest.ts) and persists the plan.
 */
export const planChunks = (
  segments: ReadonlyArray<SourceSegment>,
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
): ChunkPlan => {
  const pieces: Array<RenderedPiece> = [];
  for (const segment of segments) {
    const rendered = renderSegment(segment);
    const base = {
      speaker: segment.speaker ?? null,
      section: segment.section ?? null,
      tsStart: segment.tsStart ?? null,
      tsEnd: segment.tsEnd ?? null,
    };
    if (rendered.length <= maxChars) {
      pieces.push({ ...base, text: rendered });
    } else {
      for (const part of splitOversized(rendered, maxChars)) {
        pieces.push({ ...base, text: part });
      }
    }
  }

  const canonicalText = pieces.map((piece) => piece.text).join(SEGMENT_SEPARATOR);

  let offset = 0;
  const placed = pieces.map((piece) => {
    const charStart = offset;
    offset += piece.text.length + SEGMENT_SEPARATOR.length;
    return { ...piece, charStart };
  });

  const chunks: Array<PlannedChunk> = [];
  let pending: Array<(typeof placed)[number]> = [];
  let pendingLength = 0;

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const first = pending[0]!;
    const text = pending.map((piece) => piece.text).join(SEGMENT_SEPARATOR);
    // Chunk end time: the latest timestamp any piece carries (pieces are in
    // order, so the last timestamped piece has it). Trailing untimed pieces
    // must not drag the end back to the chunk's start.
    const lastTimed = pending.findLast((piece) => piece.tsEnd !== null || piece.tsStart !== null);
    const chunkMeta = {
      // Every pending piece shares `first`'s speaker: the loop below flushes on
      // a speaker change, so a chunk never spans two.
      speaker: first.speaker,
      section: first.section,
      tsStart: first.tsStart,
      tsEnd: lastTimed === undefined ? null : (lastTimed.tsEnd ?? lastTimed.tsStart),
    };
    chunks.push({
      ordinal: chunks.length,
      text,
      charStart: first.charStart,
      charEnd: first.charStart + text.length,
      ...chunkMeta,
    });
    pending = [];
    pendingLength = 0;
  };

  for (const piece of placed) {
    // A speaker change ends a chunk even when there is room left. Merging across
    // one used to null `speaker` (see `flush`), which dropped the speaker from
    // the contextual prefix and left the transcript UI with no turn boundaries
    // to render. Segments without a speaker — every document and email — compare
    // equal here, so their chunking is unchanged.
    const speakerChanged = pending.length > 0 && pending[0]!.speaker !== piece.speaker;
    if (
      speakerChanged ||
      (pending.length > 0 &&
        pendingLength + SEGMENT_SEPARATOR.length + piece.text.length > maxChars)
    ) {
      flush();
    }
    pendingLength =
      pending.length === 0
        ? piece.text.length
        : pendingLength + SEGMENT_SEPARATOR.length + piece.text.length;
    pending.push(piece);
  }
  flush();

  return { canonicalText, chunks };
};
