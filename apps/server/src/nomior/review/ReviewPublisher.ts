/**
 * ReviewPublisher — outbound port for review verdicts.
 *
 * Posting anywhere external (a forge comment, a board, a webhook) is behind
 * this port AND behind the engine's `allowExternalPosting` flag, which
 * defaults to false: nothing leaves the machine unless the user explicitly
 * turned posting on. The default layer is a no-op that records nothing.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { GateVerdict, ReviewJob } from "./Schemas.ts";

export interface ReviewPublication {
  readonly job: ReviewJob;
  readonly verdict: GateVerdict;
}

export interface PublishReceipt {
  readonly posted: boolean;
  readonly detail: string;
}

export class ReviewPublisher extends Context.Service<
  ReviewPublisher,
  {
    readonly publish: (publication: ReviewPublication) => Effect.Effect<PublishReceipt>;
  }
>()("t3/nomior/review/ReviewPublisher") {
  /** Default: publish nowhere. Production wiring replaces this explicitly. */
  static readonly layerNoop = Layer.succeed(
    ReviewPublisher,
    ReviewPublisher.of({
      publish: () => Effect.succeed({ posted: false, detail: "no publisher configured" }),
    }),
  );
}
