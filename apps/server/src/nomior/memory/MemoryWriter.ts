/**
 * MemoryWriter — the one way a fact becomes retrievable memory.
 *
 * Producers:
 * - the MCP `context_remember` tool, through
 *   `nomior/context/RetrievalPortLive.ts`;
 * - the review engine's `MemoryCandidateSink`, through
 *   `nomior/memory/ReviewSinkLive.ts`.
 *
 * There is no approval queue. A memory is written the moment it is produced,
 * because a queue nobody drains is a queue that loses facts, and the user
 * already sees every memory on the context page and can delete one there.
 *
 * Two invariants survive from the queue that used to sit here. Nothing enters
 * the broker unscoped — `scope` is required, and a producer that cannot name a
 * project does not write. And writing goes through the ordinary ingest path, so
 * a memory is chunked, embedded and citable exactly like a meeting or a
 * document rather than living in a side table only this feature can read.
 *
 * @module nomior/memory/MemoryWriter
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ContextIngest } from "../context/Ingest.ts";
import type { NomiorContextError, NomiorScope, NomiorSourceId } from "../context/Model.ts";

/** Which producer wrote it. Both are equal citizens. */
export const MemorySource = Schema.Literals(["review", "context-tool"]);
export type MemorySource = typeof MemorySource.Type;

export const MemoryKind = Schema.Literals(["finding", "verdict", "note"]);
export type MemoryKind = typeof MemoryKind.Type;

export interface WriteMemoryInput {
  readonly source: MemorySource;
  /** Required: nothing enters the broker unscoped. */
  readonly scope: NomiorScope;
  /** Free-form producer reference (`repo@sha` for review, a thread id for the tool). */
  readonly originRef?: string | undefined;
  readonly kind: MemoryKind;
  readonly severity?: string | undefined;
  readonly text: string;
}

export interface MemoryReceipt {
  readonly sourceId: NomiorSourceId;
  /** False when the same memory was already on file — writes are idempotent. */
  readonly created: boolean;
}

/** A memory's title is its opening; the whole text is the body. */
const TITLE_MAX_CHARS = 120;

/**
 * Content-addressed external id: the same fact written twice is one source.
 * Scope and producer reference are in the hash, so the same sentence
 * remembered for two projects stays two memories.
 */
export const memoryExternalId = (input: WriteMemoryInput): string =>
  `memory:${NodeCrypto.createHash("sha256")
    .update(
      [
        input.source,
        `${input.scope.kind}:${input.scope.value}`,
        input.originRef ?? "",
        input.kind,
        input.text,
      ].join(" "),
    )
    .digest("hex")
    .slice(0, 24)}`;

export interface MemoryWriterShape {
  readonly write: (input: WriteMemoryInput) => Effect.Effect<MemoryReceipt, NomiorContextError>;
}

export class MemoryWriter extends Context.Service<MemoryWriter, MemoryWriterShape>()(
  "t3/nomior/memory/MemoryWriter",
) {}

export const make = Effect.gen(function* () {
  const ingest = yield* ContextIngest;

  const write: MemoryWriterShape["write"] = Effect.fn("MemoryWriter.write")(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const result = yield* ingest.ingestSource({
      kind: "memory",
      externalId: memoryExternalId(input),
      title: input.text.slice(0, TITLE_MAX_CHARS),
      occurredAt: now,
      provenance: {
        memorySource: input.source,
        memoryKind: input.kind,
        ...(input.originRef === undefined ? {} : { originRef: input.originRef }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
      },
      scopes: [input.scope],
      segments: [{ text: input.text }],
    });
    return { sourceId: result.sourceId, created: result.replacedSourceId === null };
  });

  return MemoryWriter.of({ write });
});

/** Requires `ContextIngest`. */
export const MemoryWriterLive = Layer.effect(MemoryWriter, make);
