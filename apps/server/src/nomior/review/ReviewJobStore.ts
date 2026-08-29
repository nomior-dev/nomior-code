/**
 * ReviewJobStore — persistence for the review-engine state machine.
 *
 * Owns `nomior_review_jobs` and the two safety properties the engine relies
 * on: idempotent receipts (unique (repo, target, head sha) — re-submitting a
 * seen sha returns the existing job) and compare-and-swap status transitions
 * (an UPDATE guarded by the expected current status, validated against
 * `REVIEW_JOB_TRANSITIONS`).
 */
import { ThreadId, type IsoDateTime } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  GateDecision,
  ReviewJobId,
  ReviewJobStatus,
  ReviewRiskTier,
  isAllowedTransition,
  type ReviewJob,
  type ReviewTarget,
} from "./Schemas.ts";

export class ReviewJobNotFoundError extends Schema.TaggedErrorClass<ReviewJobNotFoundError>()(
  "NomiorReviewJobNotFoundError",
  { id: ReviewJobId },
) {}

export class ReviewJobTransitionError extends Schema.TaggedErrorClass<ReviewJobTransitionError>()(
  "NomiorReviewJobTransitionError",
  {
    id: ReviewJobId,
    from: ReviewJobStatus,
    to: ReviewJobStatus,
    detail: Schema.String,
  },
) {}

export interface EnqueueReviewJobInput {
  readonly repo: string;
  readonly target: ReviewTarget;
  readonly headSha: string;
  readonly riskTier: ReviewJob["riskTier"];
  readonly now: IsoDateTime;
}

/** Idempotent receipt: `created: false` means this sha was already seen. */
export interface EnqueueReviewJobReceipt {
  readonly created: boolean;
  readonly job: ReviewJob;
}

export interface TransitionReviewJobInput {
  readonly id: ReviewJobId;
  readonly from: ReviewJob["status"];
  readonly to: ReviewJob["status"];
  readonly now: IsoDateTime;
  /**
   * Columns to write alongside the status change. One semantic for every
   * field: omitted → preserved, explicitly set (including null) → written.
   */
  readonly set?: {
    readonly attempts?: number;
    readonly cooldownUntil?: IsoDateTime | null;
    readonly lastStartedAt?: IsoDateTime;
    readonly failureReason?: string | null;
    readonly verdict?: ReviewJob["verdict"];
  };
}

export interface ReviewJobStoreShape {
  readonly enqueue: (
    input: EnqueueReviewJobInput,
  ) => Effect.Effect<EnqueueReviewJobReceipt, PersistenceSqlError>;
  readonly getById: (
    id: ReviewJobId,
  ) => Effect.Effect<Option.Option<ReviewJob>, PersistenceSqlError>;
  /** Oldest queued job whose cooldown has elapsed at `now`. */
  readonly nextEligible: (
    now: IsoDateTime,
  ) => Effect.Effect<Option.Option<ReviewJob>, PersistenceSqlError>;
  /** How many reviews started (were transitioned to reviewing) since `since`. */
  readonly countStartedSince: (since: IsoDateTime) => Effect.Effect<number, PersistenceSqlError>;
  readonly transition: (
    input: TransitionReviewJobInput,
  ) => Effect.Effect<
    ReviewJob,
    PersistenceSqlError | ReviewJobNotFoundError | ReviewJobTransitionError
  >;
}

export class ReviewJobStore extends Context.Service<ReviewJobStore, ReviewJobStoreShape>()(
  "t3/nomior/review/ReviewJobStore",
) {}

const ReviewJobRow = Schema.Struct({
  id: ReviewJobId,
  repo: Schema.String,
  refKind: Schema.Literals(["pull-request", "thread"]),
  refValue: Schema.String,
  headSha: Schema.String,
  status: ReviewJobStatus,
  riskTier: ReviewRiskTier,
  attempts: Schema.Int,
  cooldownUntil: Schema.NullOr(Schema.String),
  lastStartedAt: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(GateDecision),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type ReviewJobRow = typeof ReviewJobRow.Type;

const targetToRef = (target: ReviewTarget): { refKind: string; refValue: string } =>
  target.kind === "pull-request"
    ? { refKind: "pull-request", refValue: String(target.number) }
    : { refKind: "thread", refValue: target.threadId };

const rowToJob = (row: ReviewJobRow): ReviewJob => ({
  id: row.id,
  repo: row.repo,
  target:
    row.refKind === "pull-request"
      ? { kind: "pull-request", number: Number(row.refValue) }
      : { kind: "thread", threadId: ThreadId.make(row.refValue) },
  headSha: row.headSha,
  status: row.status,
  riskTier: row.riskTier,
  attempts: row.attempts,
  cooldownUntil: row.cooldownUntil,
  lastStartedAt: row.lastStartedAt,
  failureReason: row.failureReason,
  verdict: row.verdict,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const ROW_COLUMNS = `
  id,
  repo,
  ref_kind AS "refKind",
  ref_value AS "refValue",
  head_sha AS "headSha",
  status,
  risk_tier AS "riskTier",
  attempts,
  cooldown_until AS "cooldownUntil",
  last_started_at AS "lastStartedAt",
  failure_reason AS "failureReason",
  verdict,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const findRowBySeenSha = SqlSchema.findOneOption({
    Request: Schema.Struct({
      repo: Schema.String,
      refKind: Schema.String,
      refValue: Schema.String,
      headSha: Schema.String,
    }),
    Result: ReviewJobRow,
    execute: (request) =>
      sql`
        SELECT ${sql.literal(ROW_COLUMNS)}
        FROM nomior_review_jobs
        WHERE repo = ${request.repo}
          AND ref_kind = ${request.refKind}
          AND ref_value = ${request.refValue}
          AND head_sha = ${request.headSha}
      `,
  });

  const findRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ReviewJobId }),
    Result: ReviewJobRow,
    execute: ({ id }) =>
      sql`
        SELECT ${sql.literal(ROW_COLUMNS)}
        FROM nomior_review_jobs
        WHERE id = ${id}
      `,
  });

  const findNextEligibleRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ now: Schema.String }),
    Result: ReviewJobRow,
    execute: ({ now }) =>
      sql`
        SELECT ${sql.literal(ROW_COLUMNS)}
        FROM nomior_review_jobs
        WHERE status = 'queued'
          AND (cooldown_until IS NULL OR cooldown_until <= ${now})
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
  });

  const enqueue: ReviewJobStoreShape["enqueue"] = Effect.fn("ReviewJobStore.enqueue")(
    function* (input) {
      const ref = targetToRef(input.target);
      const seen = {
        repo: input.repo,
        refKind: ref.refKind,
        refValue: ref.refValue,
        headSha: input.headSha,
      };
      const id = ReviewJobId.make(yield* Effect.orDie(crypto.randomUUIDv4));

      // INSERT OR IGNORE + re-select keeps the receipt idempotent even when
      // two submitters race: the unique seen-sha index arbitrates, and both
      // callers read back the surviving row.
      yield* sql`
      INSERT INTO nomior_review_jobs (
        id, repo, ref_kind, ref_value, head_sha,
        status, risk_tier, attempts, cooldown_until, last_started_at,
        failure_reason, verdict, created_at, updated_at
      )
      VALUES (
        ${id}, ${input.repo}, ${ref.refKind}, ${ref.refValue}, ${input.headSha},
        'queued', ${input.riskTier}, 0, NULL, NULL,
        NULL, NULL, ${input.now}, ${input.now}
      )
      ON CONFLICT (repo, ref_kind, ref_value, head_sha) DO NOTHING
    `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.enqueue:insert")));

      const row = yield* findRowBySeenSha(seen).pipe(
        Effect.mapError(toPersistenceSqlError("ReviewJobStore.enqueue:query")),
      );
      if (Option.isNone(row)) {
        return yield* Effect.die(
          new Error("nomior_review_jobs row missing immediately after enqueue"),
        );
      }
      return { created: row.value.id === id, job: rowToJob(row.value) };
    },
  );

  const getById: ReviewJobStoreShape["getById"] = Effect.fn("ReviewJobStore.getById")(
    function* (id) {
      const row = yield* findRowById({ id }).pipe(
        Effect.mapError(toPersistenceSqlError("ReviewJobStore.getById:query")),
      );
      return Option.map(row, rowToJob);
    },
  );

  const nextEligible: ReviewJobStoreShape["nextEligible"] = Effect.fn(
    "ReviewJobStore.nextEligible",
  )(function* (now) {
    const row = yield* findNextEligibleRow({ now }).pipe(
      Effect.mapError(toPersistenceSqlError("ReviewJobStore.nextEligible:query")),
    );
    return Option.map(row, rowToJob);
  });

  const countStartedSince: ReviewJobStoreShape["countStartedSince"] = Effect.fn(
    "ReviewJobStore.countStartedSince",
  )(function* (since) {
    // Counts the append-only start log, not jobs: a job that started three
    // times inside the window is three starts against the quota.
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM nomior_review_job_starts
      WHERE started_at >= ${since}
    `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.countStartedSince:query")));
    return rows[0]?.count ?? 0;
  });

  const transition: ReviewJobStoreShape["transition"] = Effect.fn("ReviewJobStore.transition")(
    function* (input) {
      if (!isAllowedTransition(input.from, input.to)) {
        return yield* new ReviewJobTransitionError({
          id: input.id,
          from: input.from,
          to: input.to,
          detail: `Transition ${input.from} -> ${input.to} is not part of the review state machine.`,
        });
      }

      // IIF(provided, value, column): omitted fields preserve the stored
      // value; an explicit null clears it. COALESCE cannot express the
      // explicit-null case, hence the provided flag.
      const set = input.set ?? {};
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE nomior_review_jobs
        SET
          status = ${input.to},
          updated_at = ${input.now},
          attempts = IIF(${set.attempts !== undefined ? 1 : 0}, ${set.attempts ?? null}, attempts),
          cooldown_until = IIF(${set.cooldownUntil !== undefined ? 1 : 0}, ${set.cooldownUntil ?? null}, cooldown_until),
          last_started_at = IIF(${set.lastStartedAt !== undefined ? 1 : 0}, ${set.lastStartedAt ?? null}, last_started_at),
          failure_reason = IIF(${set.failureReason !== undefined ? 1 : 0}, ${set.failureReason ?? null}, failure_reason),
          verdict = IIF(${set.verdict !== undefined ? 1 : 0}, ${set.verdict ?? null}, verdict)
        WHERE id = ${input.id} AND status = ${input.from}
        RETURNING id
      `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.transition:update")));

      if (updated.length === 0) {
        const current = yield* getById(input.id);
        if (Option.isNone(current)) {
          return yield* new ReviewJobNotFoundError({ id: input.id });
        }
        return yield* new ReviewJobTransitionError({
          id: input.id,
          from: input.from,
          to: input.to,
          detail: `Job is in status '${current.value.status}', expected '${input.from}'.`,
        });
      }

      // Entering `reviewing` IS starting a review (the state machine's
      // definition of a start); log it for the rolling hourly quota.
      if (input.to === "reviewing") {
        yield* sql`
          INSERT INTO nomior_review_job_starts (job_id, started_at)
          VALUES (${input.id}, ${input.now})
        `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.transition:logStart")));
      }

      const row = yield* getById(input.id);
      if (Option.isNone(row)) {
        return yield* new ReviewJobNotFoundError({ id: input.id });
      }
      return row.value;
    },
  );

  return ReviewJobStore.of({ enqueue, getById, nextEligible, countStartedSince, transition });
});

export const layer = Layer.effect(ReviewJobStore, make);
