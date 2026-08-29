import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ReviewJobStore from "./ReviewJobStore.ts";
import { ReviewJobId, type ReviewTarget } from "./Schemas.ts";

const TestLayer = ReviewJobStore.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const target: ReviewTarget = { kind: "pull-request", number: 857 };
const t0 = "2026-08-29T10:00:00.000Z";
const t1 = "2026-08-29T10:05:00.000Z";

const enqueueInput = {
  repo: "nomior-dev/nomior-code",
  target,
  headSha: "abc123",
  riskTier: "medium",
  now: t0,
} as const;

describe("ReviewJobStore", () => {
  it.effect("enqueue issues an idempotent receipt per (repo, target, head sha)", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;

      const first = yield* store.enqueue(enqueueInput);
      assert.isTrue(first.created);
      assert.strictEqual(first.job.status, "queued");
      assert.strictEqual(first.job.attempts, 0);
      assert.deepStrictEqual(first.job.target, target);

      // Same sha again: same job back, nothing new enqueued.
      const replay = yield* store.enqueue({ ...enqueueInput, now: t1 });
      assert.isFalse(replay.created);
      assert.strictEqual(replay.job.id, first.job.id);
      assert.strictEqual(replay.job.createdAt, t0);

      // A new head sha on the same PR is new work.
      const newSha = yield* store.enqueue({ ...enqueueInput, headSha: "def456" });
      assert.isTrue(newSha.created);
      assert.notStrictEqual(newSha.job.id, first.job.id);

      // A thread target with the same sha is distinct from the PR target.
      const threadTarget = yield* store.enqueue({
        ...enqueueInput,
        target: { kind: "thread", threadId: ThreadId.make("thread-1") },
      });
      assert.isTrue(threadTarget.created);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("transition is a compare-and-swap on the current status", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);

      const reviewing = yield* store.transition({
        id: job.id,
        from: "queued",
        to: "reviewing",
        now: t1,
        set: { attempts: 1, lastStartedAt: t1 },
      });
      assert.strictEqual(reviewing.status, "reviewing");
      assert.strictEqual(reviewing.attempts, 1);
      assert.strictEqual(reviewing.lastStartedAt, t1);

      // The same CAS again loses: the job is no longer queued.
      const conflict = yield* store
        .transition({ id: job.id, from: "queued", to: "reviewing", now: t1 })
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "NomiorReviewJobTransitionError");
      if (conflict._tag !== "NomiorReviewJobTransitionError") return;
      assert.match(conflict.detail, /status 'reviewing'/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects transitions outside the state machine", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);

      const error = yield* store
        .transition({ id: job.id, from: "queued", to: "approved", now: t1 })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorReviewJobTransitionError");

      const terminal = yield* store
        .transition({ id: job.id, from: "approved", to: "queued", now: t1 })
        .pipe(Effect.flip);
      assert.strictEqual(terminal._tag, "NomiorReviewJobTransitionError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with not-found for unknown jobs", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const error = yield* store
        .transition({
          id: ReviewJobId.make("missing"),
          from: "queued",
          to: "reviewing",
          now: t1,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorReviewJobNotFoundError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("nextEligible respects cooldowns and picks the oldest job", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;

      const first = yield* store.enqueue(enqueueInput);
      const second = yield* store.enqueue({ ...enqueueInput, headSha: "def456", now: t1 });

      const oldest = yield* store.nextEligible(t1);
      assert.isTrue(Option.isSome(oldest));
      if (Option.isNone(oldest)) return;
      assert.strictEqual(oldest.value.id, first.job.id);

      // Cool the first job down past `now`: the second becomes eligible.
      yield* store.transition({
        id: first.job.id,
        from: "queued",
        to: "reviewing",
        now: t1,
        set: { attempts: 1, lastStartedAt: t1 },
      });
      yield* store.transition({
        id: first.job.id,
        from: "reviewing",
        to: "queued",
        now: t1,
        set: { cooldownUntil: "2026-08-29T11:00:00.000Z" },
      });

      const next = yield* store.nextEligible(t1);
      assert.isTrue(Option.isSome(next));
      if (Option.isNone(next)) return;
      assert.strictEqual(next.value.id, second.job.id);

      // Once the cooldown elapses the first job is back, and it is older.
      const afterCooldown = yield* store.nextEligible("2026-08-29T11:00:00.000Z");
      assert.isTrue(Option.isSome(afterCooldown));
      if (Option.isNone(afterCooldown)) return;
      assert.strictEqual(afterCooldown.value.id, first.job.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("countStartedSince counts every start inside the window, not jobs", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);

      assert.strictEqual(yield* store.countStartedSince(t0), 0);

      yield* store.transition({
        id: job.id,
        from: "queued",
        to: "reviewing",
        now: t1,
        set: { attempts: 1, lastStartedAt: t1 },
      });

      assert.strictEqual(yield* store.countStartedSince(t0), 1);

      // The same job retried inside the window is a second start against the
      // quota, even though only its latest last_started_at survives.
      yield* store.transition({ id: job.id, from: "reviewing", to: "queued", now: t1 });
      const t2 = "2026-08-29T10:10:00.000Z";
      yield* store.transition({
        id: job.id,
        from: "queued",
        to: "reviewing",
        now: t2,
        set: { attempts: 2, lastStartedAt: t2 },
      });

      assert.strictEqual(yield* store.countStartedSince(t0), 2);
      assert.strictEqual(yield* store.countStartedSince("2026-08-29T10:06:00.000Z"), 1);
      assert.strictEqual(yield* store.countStartedSince("2026-08-29T10:11:00.000Z"), 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("transition preserves omitted columns and clears only on explicit null", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);

      yield* store.transition({
        id: job.id,
        from: "queued",
        to: "reviewing",
        now: t1,
        set: { attempts: 1, lastStartedAt: t1 },
      });
      const requeued = yield* store.transition({
        id: job.id,
        from: "reviewing",
        to: "queued",
        now: t1,
        set: { cooldownUntil: "2026-08-29T11:00:00.000Z", failureReason: "leg crashed" },
      });
      // Omitted fields survived the transition.
      assert.strictEqual(requeued.attempts, 1);
      assert.strictEqual(requeued.lastStartedAt, t1);

      const restarted = yield* store.transition({
        id: job.id,
        from: "queued",
        to: "reviewing",
        now: t1,
        set: { attempts: 2, cooldownUntil: null, failureReason: null },
      });
      // Explicit nulls cleared; the omitted lastStartedAt survived again.
      assert.strictEqual(restarted.cooldownUntil, null);
      assert.strictEqual(restarted.failureReason, null);
      assert.strictEqual(restarted.lastStartedAt, t1);
    }).pipe(Effect.provide(TestLayer)),
  );
});
