/**
 * ReviewJobStore — persistence for the review-engine state machine.
 *
 * Owns `nomior_review_jobs` and the two safety properties the engine relies
 * on: idempotent receipts (unique (repo, target, head sha) — re-submitting a
 * seen sha returns the existing job) and compare-and-swap status transitions
 * (an UPDATE guarded by the expected current status, validated against
 * `REVIEW_JOB_TRANSITIONS`).
 *
 * It also owns `nomior_review_finding_counts` and serves the review board's
 * read (`listRecent`), which joins the two.
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
  /** Human-readable label for the board. The engine never reads it. */
  readonly title?: string;
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

/**
 * What the review board renders: the persisted job plus the three columns the
 * engine has no use for — a human-readable title, the manual-review request
 * timestamp, and the per-severity finding tally (zeros when no leg has
 * reported yet).
 */
export interface ReviewJobBoardRow extends ReviewJob {
  readonly title: string | null;
  readonly manualReviewRequestedAt: IsoDateTime | null;
  readonly severityCounts: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
  };
}

export interface SetFindingCountsInput {
  readonly jobId: ReviewJobId;
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly now: IsoDateTime;
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
  /**
   * The board's read: newest-updated first, `failed` jobs left out because the
   * board has no column for them.
   */
  readonly listRecent: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ReviewJobBoardRow>, PersistenceSqlError>;
  /**
   * Records that a human was asked to look. Idempotent: a repeat request keeps
   * the original timestamp, and it never touches `status` — see the 006
   * migration.
   */
  readonly requestManualReview: (
    id: ReviewJobId,
    now: IsoDateTime,
  ) => Effect.Effect<ReviewJobBoardRow, PersistenceSqlError | ReviewJobNotFoundError>;
  /** Replaces the job's tally wholesale; a leg reports all its findings at once. */
  readonly setFindingCounts: (
    input: SetFindingCountsInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
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
  title: Schema.NullOr(Schema.String),
  manualReviewRequestedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type ReviewJobRow = typeof ReviewJobRow.Type;

const ReviewBoardRow = Schema.Struct({
  ...ReviewJobRow.fields,
  blocker: Schema.Int,
  major: Schema.Int,
  minor: Schema.Int,
});
type ReviewBoardRow = typeof ReviewBoardRow.Type;

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

const rowToBoardRow = (row: ReviewBoardRow): ReviewJobBoardRow => ({
  ...rowToJob(row),
  title: row.title,
  manualReviewRequestedAt: row.manualReviewRequestedAt,
  severityCounts: { blocker: row.blocker, major: row.major, minor: row.minor },
});

const jobColumns = (table: string) => `
  ${table}id,
  ${table}repo,
  ${table}ref_kind AS "refKind",
  ${table}ref_value AS "refValue",
  ${table}head_sha AS "headSha",
  ${table}status,
  ${table}risk_tier AS "riskTier",
  ${table}attempts,
  ${table}cooldown_until AS "cooldownUntil",
  ${table}last_started_at AS "lastStartedAt",
  ${table}failure_reason AS "failureReason",
  ${table}verdict,
  ${table}title,
  ${table}manual_review_requested_at AS "manualReviewRequestedAt",
  ${table}created_at AS "createdAt",
  ${table}updated_at AS "updatedAt"
`;

const ROW_COLUMNS = jobColumns("");

// `updated_at` lives on both sides of the join, so every job column is
// qualified. Missing counts row means no leg has reported: zeros, not nulls.
const BOARD_COLUMNS = `
  ${jobColumns("j.")},
  COALESCE(c.blocker, 0) AS blocker,
  COALESCE(c.major, 0) AS major,
  COALESCE(c.minor, 0) AS minor
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

  const findBoardRows = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Int }),
    Result: ReviewBoardRow,
    execute: ({ limit }) =>
      sql`
        SELECT ${sql.literal(BOARD_COLUMNS)}
        FROM nomior_review_jobs j
        LEFT JOIN nomior_review_finding_counts c ON c.job_id = j.id
        WHERE j.status <> 'failed'
        ORDER BY j.updated_at DESC, j.id ASC
        LIMIT ${limit}
      `,
  });

  const findBoardRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ReviewJobId }),
    Result: ReviewBoardRow,
    execute: ({ id }) =>
      sql`
        SELECT ${sql.literal(BOARD_COLUMNS)}
        FROM nomior_review_jobs j
        LEFT JOIN nomior_review_finding_counts c ON c.job_id = j.id
        WHERE j.id = ${id}
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
        failure_reason, verdict, title, manual_review_requested_at,
        created_at, updated_at
      )
      VALUES (
        ${id}, ${input.repo}, ${ref.refKind}, ${ref.refValue}, ${input.headSha},
        'queued', ${input.riskTier}, 0, NULL, NULL,
        NULL, NULL, ${input.title ?? null}, NULL,
        ${input.now}, ${input.now}
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

  const listRecent: ReviewJobStoreShape["listRecent"] = Effect.fn("ReviewJobStore.listRecent")(
    function* (limit) {
      const rows = yield* findBoardRows({ limit }).pipe(
        Effect.mapError(toPersistenceSqlError("ReviewJobStore.listRecent:query")),
      );
      return rows.map(rowToBoardRow);
    },
  );

  const requestManualReview: ReviewJobStoreShape["requestManualReview"] = Effect.fn(
    "ReviewJobStore.requestManualReview",
  )(function* (id, now) {
    // COALESCE, not a plain assignment: the first request is the one that
    // counts, so asking twice must not restart the clock. `updated_at` stays
    // put too — a request is not engine progress and must not reorder the board.
    const updated = yield* sql<{ readonly id: string }>`
      UPDATE nomior_review_jobs
      SET manual_review_requested_at = COALESCE(manual_review_requested_at, ${now})
      WHERE id = ${id}
      RETURNING id
    `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.requestManualReview:update")));
    if (updated.length === 0) {
      return yield* new ReviewJobNotFoundError({ id });
    }

    const row = yield* findBoardRowById({ id }).pipe(
      Effect.mapError(toPersistenceSqlError("ReviewJobStore.requestManualReview:query")),
    );
    if (Option.isNone(row)) {
      return yield* new ReviewJobNotFoundError({ id });
    }
    return rowToBoardRow(row.value);
  });

  const setFindingCounts: ReviewJobStoreShape["setFindingCounts"] = Effect.fn(
    "ReviewJobStore.setFindingCounts",
  )(function* (input) {
    yield* sql`
      INSERT INTO nomior_review_finding_counts (job_id, blocker, major, minor, updated_at)
      VALUES (${input.jobId}, ${input.blocker}, ${input.major}, ${input.minor}, ${input.now})
      ON CONFLICT (job_id) DO UPDATE SET
        blocker = excluded.blocker,
        major = excluded.major,
        minor = excluded.minor,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(toPersistenceSqlError("ReviewJobStore.setFindingCounts:upsert")));
  });

  return ReviewJobStore.of({
    enqueue,
    getById,
    nextEligible,
    countStartedSince,
    transition,
    listRecent,
    requestManualReview,
    setFindingCounts,
  });
});

export const layer = Layer.effect(ReviewJobStore, make);
