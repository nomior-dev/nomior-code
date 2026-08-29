import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MemoryCandidate, MemoryCandidateSink } from "./MemoryCandidates.ts";

const decodeCandidate = Schema.decodeUnknownOption(MemoryCandidate);

describe("MemoryCandidate", () => {
  it("accepts a review finding candidate", () => {
    const candidate = decodeCandidate({
      source: "review",
      repo: "nomior-dev/nomior-code",
      headSha: "abc123",
      kind: "finding",
      text: "missing index on jobs table",
      severity: "medium",
    });
    assert.isTrue(Option.isSome(candidate));
  });

  it("rejects candidates from unknown sources or with empty text", () => {
    const badSource = decodeCandidate({
      source: "chat",
      repo: "r",
      headSha: "s",
      kind: "finding",
      text: "t",
    });
    assert.isTrue(Option.isNone(badSource));

    const emptyText = decodeCandidate({
      source: "review",
      repo: "r",
      headSha: "s",
      kind: "verdict",
      text: "   ",
    });
    assert.isTrue(Option.isNone(emptyText));
  });
});

describe("MemoryCandidateSink", () => {
  it.effect("defaults to a sink that accepts and drops candidates", () =>
    Effect.gen(function* () {
      const sink = yield* MemoryCandidateSink;
      yield* sink.offer({
        source: "review",
        repo: "nomior-dev/nomior-code",
        headSha: "abc123",
        kind: "verdict",
        text: "Review verdict approve: clean",
      });
    }).pipe(Effect.provide(MemoryCandidateSink.layerNoop)),
  );
});
