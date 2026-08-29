import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, describe, it } from "@effect/vitest";

import {
  NomiorContextSqlError,
  NomiorSourceId,
  type NomiorContextError,
} from "../context/Model.ts";
import { NomiorProjects } from "../projects/NomiorProjects.ts";
import { MemoryCandidateSink } from "../review/MemoryCandidates.ts";
import { MemoryWriter, type WriteMemoryInput } from "./MemoryWriter.ts";
import { MemoryCandidateSinkLive } from "./ReviewSinkLive.ts";

interface WriterStubOptions {
  readonly writes: Array<WriteMemoryInput>;
  readonly fail?: boolean;
}

const writerStub = (options: WriterStubOptions) =>
  Layer.succeed(
    MemoryWriter,
    MemoryWriter.of({
      write: (input) => {
        options.writes.push(input);
        return options.fail === true
          ? Effect.fail<NomiorContextError>(
              new NomiorContextSqlError({ operation: "test", cause: new Error("disk on fire") }),
            )
          : Effect.succeed({ sourceId: NomiorSourceId.make("src-1"), created: true });
      },
    }),
  );

const PROJECTS = NomiorProjects.layerStatic([
  {
    projectId: ProjectId.make("proj-code"),
    title: "Code",
    workspaceRoot: "/w/code",
    repo: "nomior-dev/nomior-code",
  },
]);

const finding = {
  source: "review",
  repo: "nomior-dev/nomior-code",
  headSha: "abc1234",
  kind: "finding",
  severity: "high",
  text: "Retries double-charge the payment intent.",
} as const;

const sinkWith = (writer: Layer.Layer<MemoryWriter>) =>
  MemoryCandidateSinkLive.pipe(Layer.provide(Layer.mergeAll(writer, PROJECTS)));

describe("MemoryCandidateSinkLive", () => {
  it.effect("writes a finding straight to memory, scoped to the repo's project", () =>
    Effect.gen(function* () {
      const writes: Array<WriteMemoryInput> = [];
      yield* Effect.flatMap(MemoryCandidateSink, (sink) => sink.offer(finding)).pipe(
        Effect.provide(sinkWith(writerStub({ writes }))),
      );

      assert.strictEqual(writes.length, 1);
      assert.deepStrictEqual(writes[0]?.scope, { kind: "project", value: "proj-code" });
      assert.strictEqual(writes[0]?.source, "review");
      assert.strictEqual(writes[0]?.originRef, "nomior-dev/nomior-code@abc1234");
      assert.strictEqual(writes[0]?.severity, "high");
    }),
  );

  it.effect(
    "skips a repo no checkout on this machine points at, rather than guessing a scope",
    () =>
      Effect.gen(function* () {
        const writes: Array<WriteMemoryInput> = [];
        yield* Effect.flatMap(MemoryCandidateSink, (sink) =>
          sink.offer({ ...finding, repo: "someone-else/unknown" }),
        ).pipe(Effect.provide(sinkWith(writerStub({ writes }))));

        assert.deepStrictEqual(writes, []);
      }),
  );

  it.effect("swallows a write failure: a review must not fail because memory did", () =>
    Effect.gen(function* () {
      const writes: Array<WriteMemoryInput> = [];
      yield* Effect.flatMap(MemoryCandidateSink, (sink) => sink.offer(finding)).pipe(
        Effect.provide(sinkWith(writerStub({ writes, fail: true }))),
      );

      assert.strictEqual(writes.length, 1);
    }),
  );
});
