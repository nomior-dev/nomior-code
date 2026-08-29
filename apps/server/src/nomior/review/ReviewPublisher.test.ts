import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ReviewPublisher } from "./ReviewPublisher.ts";
import { ReviewJobId, type GateVerdict, type ReviewJob } from "./Schemas.ts";

const job: ReviewJob = {
  id: ReviewJobId.make("job-1"),
  repo: "nomior-dev/nomior-code",
  target: { kind: "thread", threadId: ThreadId.make("thread-1") },
  headSha: "abc123",
  status: "approved",
  riskTier: "low",
  attempts: 1,
  cooldownUntil: null,
  lastStartedAt: "2026-08-29T10:00:00.000Z",
  failureReason: null,
  verdict: "approve",
  createdAt: "2026-08-29T10:00:00.000Z",
  updatedAt: "2026-08-29T10:00:00.000Z",
};

const verdict: GateVerdict = { decision: "approve", reasons: ["clean"], followups: [] };

describe("ReviewPublisher", () => {
  it.effect("defaults to a no-op that posts nowhere", () =>
    Effect.gen(function* () {
      const publisher = yield* ReviewPublisher;
      const receipt = yield* publisher.publish({ job, verdict });
      assert.isFalse(receipt.posted);
      assert.match(receipt.detail, /no publisher configured/);
    }).pipe(Effect.provide(ReviewPublisher.layerNoop)),
  );
});
