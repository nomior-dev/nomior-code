/**
 * MemoryCandidateSink — port through which review results feed the memory
 * layer as candidates. Candidates require explicit promotion elsewhere
 * (PLAN.md: nothing promotes without approval); this module deliberately
 * implements no storage — the memory track owns that.
 */
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { FindingSeverity } from "./Schemas.ts";

export const MemoryCandidate = Schema.Struct({
  source: Schema.Literal("review"),
  repo: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  kind: Schema.Literals(["finding", "verdict"]),
  text: TrimmedNonEmptyString,
  severity: Schema.optional(FindingSeverity),
});
export type MemoryCandidate = typeof MemoryCandidate.Type;

export class MemoryCandidateSink extends Context.Service<
  MemoryCandidateSink,
  {
    readonly offer: (candidate: MemoryCandidate) => Effect.Effect<void>;
  }
>()("t3/nomior/review/MemoryCandidates/MemoryCandidateSink") {
  /** Default: drop candidates until the memory track provides a real sink. */
  static readonly layerNoop = Layer.succeed(
    MemoryCandidateSink,
    MemoryCandidateSink.of({ offer: () => Effect.void }),
  );
}
