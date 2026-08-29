/**
 * Model - shared shapes and errors for the Nomior context broker.
 *
 * Everything the broker stores or returns is described here with Effect
 * Schema. Wire contracts (MCP toolkit, RPC) derive from these shapes in their
 * own track; nothing in this module crosses the network.
 *
 * @module Model
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const NomiorSourceId = TrimmedNonEmptyString.pipe(Schema.brand("NomiorSourceId"));
export type NomiorSourceId = typeof NomiorSourceId.Type;

/** Chunk ids are deterministic: `${sourceId}/${ordinal}`. */
export const NomiorChunkId = TrimmedNonEmptyString.pipe(Schema.brand("NomiorChunkId"));
export type NomiorChunkId = typeof NomiorChunkId.Type;

export const NomiorSourceKind = Schema.Literals([
  "meeting",
  "document",
  "email",
  "memory",
  "decision",
  "session",
]);
export type NomiorSourceKind = typeof NomiorSourceKind.Type;

export const NomiorScopeKind = Schema.Literals(["project", "customer", "capsule"]);
export type NomiorScopeKind = typeof NomiorScopeKind.Type;

/** One scope binding, e.g. `{ kind: "project", value: "proj-alpha" }`. */
export const NomiorScope = Schema.Struct({
  kind: NomiorScopeKind,
  value: TrimmedNonEmptyString,
});
export type NomiorScope = typeof NomiorScope.Type;

/**
 * One unit of the normalized source content: a speaker turn in a meeting, a
 * paragraph or section in a document, a message in an email thread. Chunking
 * never splits a segment across chunks (unless a single segment alone exceeds
 * the maximum chunk size).
 */
export const SourceSegment = Schema.Struct({
  text: TrimmedNonEmptyString,
  speaker: Schema.optional(TrimmedNonEmptyString),
  section: Schema.optional(TrimmedNonEmptyString),
  /** Seconds from the start of the recording, for meeting sources. */
  tsStart: Schema.optional(Schema.Number),
  tsEnd: Schema.optional(Schema.Number),
});
export type SourceSegment = typeof SourceSegment.Type;

/**
 * Evidence pointing into the canonical source text by character range.
 *
 * The canonical text is what `planChunks` (Chunking.ts) renders from the
 * segments — speaker prefixes included, `\n\n` between pieces. Callers obtain
 * it either by running the exported pure `planChunks` over the same segments
 * before ingesting, or from `IngestResult.canonicalText` after a first ingest
 * (extract → re-ingest with the same `(kind, externalId)` replaces the source
 * atomically). Offsets against the raw segment texts are wrong.
 */
export const EvidenceSpan = Schema.Struct({
  charStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  charEnd: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type EvidenceSpan = typeof EvidenceSpan.Type;

export const DecisionInput = Schema.Struct({
  statement: TrimmedNonEmptyString,
  decidedAt: Schema.optional(IsoDateTime),
  evidence: Schema.optional(EvidenceSpan),
});
export type DecisionInput = typeof DecisionInput.Type;

export const TaskStatus = Schema.Literals(["open", "done", "dropped"]);
export type TaskStatus = typeof TaskStatus.Type;

export const TaskInput = Schema.Struct({
  description: TrimmedNonEmptyString,
  assignee: Schema.optional(TrimmedNonEmptyString),
  dueAt: Schema.optional(IsoDateTime),
  status: Schema.optional(TaskStatus),
  evidence: Schema.optional(EvidenceSpan),
});
export type TaskInput = typeof TaskInput.Type;

export const SourceInput = Schema.Struct({
  kind: NomiorSourceKind,
  /**
   * Stable id in the source system (Gmail message id, recorder session id, file
   * path). Re-ingesting the same `(kind, externalId)` replaces the previous
   * source atomically.
   */
  externalId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  occurredAt: Schema.optional(IsoDateTime),
  provenance: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** At least one scope: nothing enters the broker unscoped. */
  scopes: Schema.NonEmptyArray(NomiorScope),
  segments: Schema.Array(SourceSegment),
  decisions: Schema.optional(Schema.Array(DecisionInput)),
  tasks: Schema.optional(Schema.Array(TaskInput)),
});
export type SourceInput = typeof SourceInput.Type;

export const IngestResult = Schema.Struct({
  sourceId: NomiorSourceId,
  chunkIds: Schema.Array(NomiorChunkId),
  /** Source replaced because it carried the same `(kind, externalId)`. */
  replacedSourceId: Schema.NullOr(NomiorSourceId),
  /** The rendered text `EvidenceSpan` offsets point into (see its docs). */
  canonicalText: Schema.String,
});
export type IngestResult = typeof IngestResult.Type;

export const RetrievedSnippet = Schema.Struct({
  sourceId: NomiorSourceId,
  chunkId: NomiorChunkId,
  sourceKind: NomiorSourceKind,
  title: Schema.String,
  /** Deterministic header prepended at ingest time (title, section/time, speaker). */
  contextualPrefix: Schema.String,
  text: Schema.String,
  /** Evidence span: offsets into the canonical source text. */
  charStart: Schema.Int,
  charEnd: Schema.Int,
  ordinal: Schema.Int,
  speaker: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(IsoDateTime),
  /** Fused relevance score (higher is better). */
  score: Schema.Number,
  citation: Schema.String,
});
export type RetrievedSnippet = typeof RetrievedSnippet.Type;

export const SearchResult = Schema.Struct({
  snippets: Schema.Array(RetrievedSnippet),
  budgetTokens: Schema.Int,
  usedTokens: Schema.Int,
  truncated: Schema.Boolean,
  /** Present only when truncated: steers the caller toward a narrower query. */
  notice: Schema.NullOr(Schema.String),
});
export type SearchResult = typeof SearchResult.Type;

// ===============================
// Errors
// ===============================

export class NomiorContextSqlError extends Schema.TaggedErrorClass<NomiorContextSqlError>()(
  "NomiorContextSqlError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}`;
  }
}

export class NomiorContextDecodeError extends Schema.TaggedErrorClass<NomiorContextDecodeError>()(
  "NomiorContextDecodeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}`;
  }
}

export class NomiorEmbeddingError extends Schema.TaggedErrorClass<NomiorEmbeddingError>()(
  "NomiorEmbeddingError",
  {
    modelId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Embedding failed for model ${this.modelId}: ${this.detail}`;
  }
}

export type NomiorContextError = NomiorContextSqlError | NomiorContextDecodeError;

export function toNomiorContextSqlError(operation: string) {
  return (cause: unknown): NomiorContextSqlError => new NomiorContextSqlError({ operation, cause });
}

export const chunkIdFor = (sourceId: NomiorSourceId, ordinal: number): NomiorChunkId =>
  NomiorChunkId.make(`${sourceId}/${ordinal}`);
