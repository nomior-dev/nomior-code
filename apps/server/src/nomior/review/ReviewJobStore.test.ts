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

  it.effect("enqueue round-trips an optional board title", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;

      yield* store.enqueue({ ...enqueueInput, title: "fix(web): board title" });
      yield* store.enqueue({ ...enqueueInput, headSha: "def456", now: t1 });

      const board = yield* store.listRecent(10);
      const titled = board.find((row) => row.headSha === "abc123");
      const untitled = board.find((row) => row.headSha === "def456");
      assert.strictEqual(titled?.title, "fix(web): board title");
      assert.strictEqual(untitled?.title, null);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a merged or closed pull request leaves the board but keeps its page", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;

      const { job } = yield* store.enqueue(enqueueInput);
      const other = yield* store.enqueue({ ...enqueueInput, headSha: "def456", now: t1 });
      assert.strictEqual((yield* store.listRecent(10)).length, 2);

      yield* store.setPullRequestState(job.id, "merged");

      const board = yield* store.listRecent(10);
      assert.deepStrictEqual(
        board.map((row) => row.id),
        [other.job.id],
      );

      // The job itself is untouched: this is forge news, not engine progress.
      const dropped = yield* store.getBoardRow(job.id);
      assert.isTrue(Option.isSome(dropped));
      assert.strictEqual(Option.getOrThrow(dropped).pullRequestState, "merged");
      assert.strictEqual(Option.getOrThrow(dropped).status, job.status);
      assert.strictEqual(Option.getOrThrow(dropped).updatedAt, job.updatedAt);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("setPullRequestState refuses an id no job has", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const failure = yield* Effect.flip(
        store.setPullRequestState(ReviewJobId.make("missing"), "closed"),
      );
      assert.strictEqual(failure._tag, "NomiorReviewJobNotFoundError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a new job is open until the forge says otherwise", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);
      assert.strictEqual(job.pullRequestState, "open");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("listRecent orders by updated_at desc and hides failed jobs", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;

      const first = yield* store.enqueue(enqueueInput);
      const second = yield* store.enqueue({ ...enqueueInput, headSha: "def456", now: t1 });
      const third = yield* store.enqueue({ ...enqueueInput, headSha: "ghi789", now: t1 });

      // The oldest job is touched last, so it must lead the board.
      const t2 = "2026-08-29T10:10:00.000Z";
      yield* store.transition({ id: first.job.id, from: "queued", to: "reviewing", now: t2 });

      // second and third tie on updated_at, so id breaks the tie: total order.
      const tied = [second.job.id, third.job.id].sort();
      const board = yield* store.listRecent(10);
      assert.deepStrictEqual(
        board.map((row) => row.id),
        [first.job.id, ...tied],
      );

      // A failed job leaves the board entirely; the rest keep their order.
      yield* store.transition({ id: first.job.id, from: "reviewing", to: "failed", now: t2 });
      const afterFailure = yield* store.listRecent(10);
      assert.isFalse(afterFailure.some((row) => row.id === first.job.id));
      assert.strictEqual(afterFailure.length, 2);

      assert.strictEqual((yield* store.listRecent(1)).length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("listRecent reports zero counts until a leg reports", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);

      const before = yield* store.listRecent(10);
      assert.deepStrictEqual(before[0]?.severityCounts, { blocker: 0, major: 0, minor: 0 });

      yield* store.setFindingCounts({ jobId: job.id, blocker: 1, major: 2, minor: 3, now: t1 });
      const after = yield* store.listRecent(10);
      assert.deepStrictEqual(after[0]?.severityCounts, { blocker: 1, major: 2, minor: 3 });

      // The upsert replaces the tally wholesale rather than accumulating.
      yield* store.setFindingCounts({ jobId: job.id, blocker: 0, major: 0, minor: 5, now: t1 });
      const replaced = yield* store.listRecent(10);
      assert.deepStrictEqual(replaced[0]?.severityCounts, { blocker: 0, major: 0, minor: 5 });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("requestManualReview is idempotent and never touches status", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const { job } = yield* store.enqueue(enqueueInput);
      yield* store.transition({ id: job.id, from: "queued", to: "reviewing", now: t0 });

      const requested = yield* store.requestManualReview(job.id, t1);
      assert.strictEqual(requested.manualReviewRequestedAt, t1);
      assert.strictEqual(requested.status, "reviewing");

      const again = yield* store.requestManualReview(job.id, "2026-08-29T12:00:00.000Z");
      assert.deepStrictEqual(again, requested);

      // The engine's own view of the job is untouched: same status, same clock.
      const stored = yield* store.getById(job.id);
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.status, "reviewing");
      assert.strictEqual(stored.value.updatedAt, t0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("requestManualReview fails with not-found for unknown jobs", () =>
    Effect.gen(function* () {
      const store = yield* ReviewJobStore.ReviewJobStore;
      const error = yield* store
        .requestManualReview(ReviewJobId.make("missing"), t1)
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorReviewJobNotFoundError");
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
