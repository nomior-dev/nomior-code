import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NomiorContextSqlError } from "../context/Model.ts";
import { MemoryCandidateSink } from "../review/MemoryCandidates.ts";
import { MemoryCandidateStore, type OfferMemoryCandidateInput } from "./MemoryCandidateStore.ts";
import { MemoryCandidateSinkLive } from "./ReviewSinkLive.ts";

const storeStub = (options: {
  readonly offers: Array<OfferMemoryCandidateInput>;
  readonly fail?: boolean;
}) =>
  Layer.succeed(MemoryCandidateStore, {
    offer: (input) => {
      options.offers.push(input);
      return options.fail === true
        ? Effect.fail(new NomiorContextSqlError({ operation: "test" }))
        : Effect.succeed({
            candidateId: "memc_test" as never,
            status: "pending_approval" as const,
            created: true,
          });
    },
    list: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    approve: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
  });

describe("MemoryCandidateSinkLive", () => {
  it.effect("files a review finding as an unscoped candidate keyed by repo@sha", () =>
    Effect.gen(function* () {
      const offers: Array<OfferMemoryCandidateInput> = [];
      yield* Effect.flatMap(MemoryCandidateSink, (sink) =>
        sink.offer({
          source: "review",
          repo: "nomior/nomior-code",
          headSha: "abc1234",
          kind: "finding",
          text: "The port swallowed a scope error.",
          severity: "high",
        }),
      ).pipe(Effect.provide(MemoryCandidateSinkLive.pipe(Layer.provide(storeStub({ offers })))));

      assert.deepStrictEqual(offers, [
        {
          source: "review",
          scope: null,
          originRef: "nomior/nomior-code@abc1234",
          kind: "finding",
          severity: "high",
          text: "The port swallowed a scope error.",
        },
      ]);
    }),
  );

  it.effect("a store write failure never fails the review that produced it", () =>
    Effect.gen(function* () {
      const offers: Array<OfferMemoryCandidateInput> = [];
      // The port's signature is infallible on purpose: a verdict must stand
      // even when the candidate could not be filed.
      yield* Effect.flatMap(MemoryCandidateSink, (sink) =>
        sink.offer({
          source: "review",
          repo: "nomior/nomior-code",
          headSha: "abc1234",
          kind: "verdict",
          text: "Review verdict approve.",
        }),
      ).pipe(
        Effect.provide(
          MemoryCandidateSinkLive.pipe(Layer.provide(storeStub({ offers, fail: true }))),
        ),
      );
      assert.strictEqual(offers.length, 1);
    }),
  );
});
