import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { NomiorSqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { LegRunError, LegRunner, type ReviewLegConfig } from "./Legs.ts";
import { MemoryCandidateSink, type MemoryCandidate } from "./MemoryCandidates.ts";
import type { PlaybookPresence } from "./Playbook.ts";
import * as ReviewEngine from "./ReviewEngine.ts";
import * as ReviewJobStore from "./ReviewJobStore.ts";
import { ReviewPublisher, type ReviewPublication } from "./ReviewPublisher.ts";
import type { ReviewTarget } from "./Schemas.ts";

const playbook: PlaybookPresence = {
  kind: "present",
  playbook: { verify: "run tests", context: "monorepo", bar: "no criticals" },
};

const legs: ReadonlyArray<ReviewLegConfig> = [
  {
    role: "claude-verify",
    instanceId: ProviderInstanceId.make("claude-work"),
    model: "opus-5",
    attachedTools: ["shell"],
  },
  {
    role: "codex-read",
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
    attachedTools: [],
  },
];

const APPROVE_OUTPUT =
  '{"findings": [], "runtimeEvidence": [{"kind": "tests-run", "detail": "vitest 42 passed"}]}';

const target: ReviewTarget = { kind: "pull-request", number: 857 };
const submitInput = {
  repo: "nomior-dev/nomior-code",
  target,
  headSha: "abc123",
  riskTier: "medium",
} as const;

interface Harness {
  readonly runs: Array<{ readonly config: ReviewLegConfig; readonly brief: string }>;
  readonly publications: Array<ReviewPublication>;
  readonly memoryCandidates: Array<MemoryCandidate>;
}

const makeHarness = (): Harness => ({ runs: [], publications: [], memoryCandidates: [] });

/** Engine wired to fakes: scripted leg outputs, spy publisher, spy sink. */
const makeTestLayer = (options: {
  readonly harness: Harness;
  readonly legOutput?: (config: ReviewLegConfig) => string;
  readonly legFailure?: (config: ReviewLegConfig) => LegRunError | null;
  readonly settings?: Parameters<typeof ReviewEngine.ReviewEngineConfig.layerStatic>[0];
  readonly playbook?: PlaybookPresence;
}) => {
  const legRunnerLayer = Layer.succeed(
    LegRunner,
    LegRunner.of({
      run: (config, brief) =>
        Effect.gen(function* () {
          options.harness.runs.push({ config, brief });
          const failure = options.legFailure?.(config) ?? null;
          if (failure !== null) {
            return yield* failure;
          }
          return { rawOutput: options.legOutput?.(config) ?? APPROVE_OUTPUT };
        }),
    }),
  );
  const publisherLayer = Layer.succeed(
    ReviewPublisher,
    ReviewPublisher.of({
      publish: (publication) =>
        Effect.sync(() => {
          options.harness.publications.push(publication);
          return { posted: true, detail: "posted by fake publisher" };
        }),
    }),
  );
  const memoryLayer = Layer.succeed(
    MemoryCandidateSink,
    MemoryCandidateSink.of({
      offer: (candidate) =>
        Effect.sync(() => {
          options.harness.memoryCandidates.push(candidate);
        }),
    }),
  );

  return ReviewEngine.layer.pipe(
    Layer.provide(legRunnerLayer),
    Layer.provide(publisherLayer),
    Layer.provide(memoryLayer),
    Layer.provide(ReviewEngine.ReviewEngineConfig.layerStatic(options.settings)),
    Layer.provide(
      ReviewEngine.ReviewRunContexts.layerStatic({
        legs,
        playbook: options.playbook ?? playbook,
        brief: { contextPacket: null, changeSummary: "adds the scheduler" },
      }),
    ),
    Layer.provideMerge(ReviewJobStore.layer),
    Layer.provideMerge(NomiorSqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("ReviewEngine", () => {
  it.effect("is idle with nothing queued", () =>
    Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;
      const outcome = yield* engine.processNext();
      assert.deepStrictEqual(outcome, { kind: "idle" });
    }).pipe(Effect.provide(makeTestLayer({ harness: makeHarness() }))),
  );

  it.effect("runs a job to approval and re-submitting the sha stays idempotent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      const receipt = yield* engine.submit(submitInput);
      assert.isTrue(receipt.created);
      const replay = yield* engine.submit(submitInput);
      assert.isFalse(replay.created);
      assert.strictEqual(replay.job.id, receipt.job.id);

      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.strictEqual(outcome.job.status, "approved");
      assert.strictEqual(outcome.verdict.decision, "approve");
      assert.strictEqual(harness.runs.length, 2);
      // Each leg got its own brief, built from its own tool attachment.
      assert.match(harness.runs[0]?.brief ?? "", /How to verify/);
      assert.notMatch(harness.runs[1]?.brief ?? "", /How to verify/);

      // A completed job never runs again.
      const after = yield* engine.processNext();
      assert.deepStrictEqual(after, { kind: "idle" });
    }).pipe(Effect.provide(makeTestLayer({ harness })));
  });

  it.effect("never publishes externally without explicit approval", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      // The fake publisher would have posted; the flag (default false)
      // means it was never called.
      assert.isFalse(outcome.publish.posted);
      assert.match(outcome.publish.detail, /not approved/);
      assert.deepStrictEqual(harness.publications, []);
    }).pipe(Effect.provide(makeTestLayer({ harness })));
  });

  it.effect("publishes when external posting is explicitly enabled", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.isTrue(outcome.publish.posted);
      assert.strictEqual(harness.publications.length, 1);
    }).pipe(Effect.provide(makeTestLayer({ harness, settings: { allowExternalPosting: true } })));
  });

  it.effect("feeds the verdict and followup findings back as memory candidates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.strictEqual(outcome.verdict.decision, "approve-with-followups");

      const kinds = harness.memoryCandidates.map((candidate) => candidate.kind);
      assert.deepStrictEqual(kinds, ["verdict", "finding"]);
      assert.strictEqual(harness.memoryCandidates[1]?.text, "missing index on jobs table");
      assert.strictEqual(harness.memoryCandidates[1]?.severity, "medium");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legOutput: (config) =>
            config.role === "codex-read"
              ? '{"findings": [{"severity": "medium", "summary": "missing index on jobs table"}]}'
              : APPROVE_OUTPUT,
        }),
      ),
    );
  });

  it.effect("a critical finding lands as not-approved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.strictEqual(outcome.job.status, "not-approved");
      assert.strictEqual(outcome.job.verdict, "not-approved");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legOutput: () =>
            '{"findings": [{"severity": "critical", "summary": "secrets in log output"}]}',
        }),
      ),
    );
  });

  it.effect("unparseable leg output fails closed to not-approved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.strictEqual(outcome.job.status, "not-approved");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legOutput: (config) => (config.role === "codex-read" ? "LGTM!" : APPROVE_OUTPUT),
        }),
      ),
    );
  });

  it.effect("a failed leg run schedules a cooled-down retry, then eventually fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);

      const first = yield* engine.processNext();
      assert.strictEqual(first.kind, "retry-scheduled");
      if (first.kind !== "retry-scheduled") return;
      assert.strictEqual(first.job.status, "queued");
      assert.strictEqual(first.job.attempts, 1);
      // attempt 1: base * 2^0 = 300s past the (test-clock) epoch.
      assert.strictEqual(first.cooldownUntil, "1970-01-01T00:05:00.000Z");

      // Still cooling down: the job is not eligible.
      const during = yield* engine.processNext();
      assert.deepStrictEqual(during, { kind: "idle" });

      yield* TestClock.adjust(Duration.minutes(5));
      const second = yield* engine.processNext();
      assert.strictEqual(second.kind, "failed");
      if (second.kind !== "failed") return;
      assert.strictEqual(second.job.status, "failed");
      assert.match(second.job.failureReason ?? "", /Gave up after 2 attempts/);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legFailure: (config) =>
            config.role === "claude-verify"
              ? new LegRunError({
                  legRole: config.role,
                  detail: "provider session crashed",
                  rateLimited: false,
                })
              : null,
          settings: { maxAttempts: 2, cooldownBaseSeconds: 300 },
        }),
      ),
    );
  });

  it.effect("rate-limited failures cool down much longer", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "retry-scheduled");
      if (outcome.kind !== "retry-scheduled") return;
      // Rate-limit base (3600s), not the ordinary 300s.
      assert.strictEqual(outcome.cooldownUntil, "1970-01-01T01:00:00.000Z");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legFailure: (config) =>
            new LegRunError({
              legRole: config.role,
              detail: "rate limited by provider",
              rateLimited: true,
            }),
          settings: { cooldownBaseSeconds: 300, rateLimitCooldownSeconds: 3600 },
        }),
      ),
    );
  });

  it.effect("enforces the hourly quota on review starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      yield* engine.submit(submitInput);
      yield* engine.submit({ ...submitInput, headSha: "def456" });

      const first = yield* engine.processNext();
      assert.strictEqual(first.kind, "completed");

      const second = yield* engine.processNext();
      assert.deepStrictEqual(second, { kind: "quota-exhausted", startedInLastHour: 1 });

      // The window rolls: once the first start ages out, the second job runs.
      yield* TestClock.adjust(Duration.minutes(61));
      const third = yield* engine.processNext();
      assert.strictEqual(third.kind, "completed");
    }).pipe(Effect.provide(makeTestLayer({ harness, settings: { hourlyQuota: 1 } })));
  });

  it.effect("hands a review to a human via waiting-external and records their decision", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;

      const { job } = yield* engine.submit(submitInput);
      const outcome = yield* engine.processNext();
      assert.strictEqual(outcome.kind, "waiting-external");
      if (outcome.kind !== "waiting-external") return;
      assert.strictEqual(outcome.job.status, "waiting-external");

      const resolved = yield* engine.resolveExternal(job.id, "approved", "reviewed by hand");
      assert.strictEqual(resolved.status, "approved");
      assert.strictEqual(resolved.verdict, "approve");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          harness,
          legOutput: () => '{"findings": [], "needsExternalReview": true}',
        }),
      ),
    );
  });
});
