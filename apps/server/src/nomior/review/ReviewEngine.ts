/**
 * ReviewEngine — the state machine driver over `nomior_review_jobs`.
 *
 * One `processNext` call takes one eligible job through: quota check →
 * queued→reviewing → run legs (via the `LegRunner` port) → parse → the
 * deterministic gate → terminal status. Failures retry with exponential
 * cooldown (much longer when a leg was rate limited) up to `maxAttempts`,
 * then land in `failed`. Verdicts publish only when `allowExternalPosting`
 * is explicitly on, and findings feed the memory layer as candidates
 * through the `MemoryCandidateSink` port.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectId } from "@t3tools/contracts";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import { evaluateGate, hasBlockingFindings } from "./Gate.ts";
import {
  LegRunner,
  buildLegBrief,
  parseLegOutput,
  reviewSchedulerProjectKey,
  type LegBriefInput,
  type ReviewLegConfig,
} from "./Legs.ts";
import { MemoryCandidateSink } from "./MemoryCandidates.ts";
import type { PlaybookPresence } from "./Playbook.ts";
import { ReviewPublisher, type PublishReceipt } from "./ReviewPublisher.ts";
import {
  ReviewJobStore,
  type EnqueueReviewJobReceipt,
  type ReviewJobNotFoundError,
  type ReviewJobTransitionError,
} from "./ReviewJobStore.ts";
import type {
  GateVerdict,
  ParsedLegResult,
  ReviewJob,
  ReviewJobId,
  ReviewRiskTier,
  ReviewTarget,
} from "./Schemas.ts";

export const ReviewEngineSettings = Schema.Struct({
  /** Reviews that may START per rolling hour. */
  hourlyQuota: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(6))),
  maxAttempts: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  /** Base retry cooldown, doubled per attempt. */
  cooldownBaseSeconds: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(300))),
  /** Rate-limit failures back off from this much longer base instead. */
  rateLimitCooldownSeconds: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(3600))),
  /**
   * External posting (forge comments etc.) requires this explicit opt-in.
   * Off by default: verdicts stay local until the user approves posting.
   */
  allowExternalPosting: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ReviewEngineSettings = typeof ReviewEngineSettings.Type;

export const DEFAULT_REVIEW_ENGINE_SETTINGS: ReviewEngineSettings = Schema.decodeSync(
  ReviewEngineSettings,
)({});

export class ReviewEngineConfig extends Context.Service<
  ReviewEngineConfig,
  { readonly current: Effect.Effect<ReviewEngineSettings> }
>()("t3/nomior/review/ReviewEngine/ReviewEngineConfig") {
  static readonly layerStatic = (settings?: Partial<ReviewEngineSettings>) =>
    Layer.succeed(
      ReviewEngineConfig,
      ReviewEngineConfig.of({
        current: Effect.succeed({ ...DEFAULT_REVIEW_ENGINE_SETTINGS, ...settings }),
      }),
    );

  static readonly layerDefault = ReviewEngineConfig.layerStatic();
}

/** Everything needed to actually run one job's review. */
export interface ReviewRunContext {
  readonly legs: ReadonlyArray<ReviewLegConfig>;
  readonly playbook: PlaybookPresence;
  readonly brief: Omit<LegBriefInput, "playbook">;
}

export class ReviewRunContextError extends Schema.TaggedErrorClass<ReviewRunContextError>()(
  "NomiorReviewRunContextError",
  { detail: Schema.String },
) {}

/**
 * Resolves per-job review context (leg configuration, repo playbook, change
 * summary). A port: production wiring reads review config + the playbook
 * from the repo/profile; tests provide values directly.
 */
export class ReviewRunContexts extends Context.Service<
  ReviewRunContexts,
  {
    readonly resolve: (job: ReviewJob) => Effect.Effect<ReviewRunContext, ReviewRunContextError>;
  }
>()("t3/nomior/review/ReviewEngine/ReviewRunContexts") {
  static readonly layerStatic = (context: ReviewRunContext) =>
    Layer.succeed(
      ReviewRunContexts,
      ReviewRunContexts.of({ resolve: () => Effect.succeed(context) }),
    );
}

export interface SubmitReviewInput {
  readonly repo: string;
  readonly target: ReviewTarget;
  readonly headSha: string;
  readonly riskTier: ReviewRiskTier;
}

export type ProcessOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "quota-exhausted"; readonly startedInLastHour: number }
  | {
      readonly kind: "completed";
      readonly job: ReviewJob;
      readonly verdict: GateVerdict;
      readonly publish: PublishReceipt;
    }
  | { readonly kind: "waiting-external"; readonly job: ReviewJob }
  | { readonly kind: "retry-scheduled"; readonly job: ReviewJob; readonly cooldownUntil: string }
  | { readonly kind: "failed"; readonly job: ReviewJob };

export type ReviewEngineError =
  | PersistenceSqlError
  | ReviewJobNotFoundError
  | ReviewJobTransitionError
  | ReviewRunContextError;

export interface ReviewEngineShape {
  /** Idempotent: re-submitting a seen (repo, target, sha) returns the existing job. */
  readonly submit: (
    input: SubmitReviewInput,
  ) => Effect.Effect<EnqueueReviewJobReceipt, PersistenceSqlError>;
  /** Drive at most one job one step forward. */
  readonly processNext: () => Effect.Effect<ProcessOutcome, ReviewEngineError>;
  /**
   * Manual resolution for jobs handed to a human (`waiting-external`). The
   * decision is the human's; the engine only records it.
   */
  readonly resolveExternal: (
    id: ReviewJobId,
    decision: "approved" | "not-approved",
    note: string,
  ) => Effect.Effect<ReviewJob, ReviewEngineError>;
}

export class ReviewEngine extends Context.Service<ReviewEngine, ReviewEngineShape>()(
  "t3/nomior/review/ReviewEngine",
) {}

export const make = Effect.gen(function* () {
  const store = yield* ReviewJobStore;
  const legRunner = yield* LegRunner;
  const publisher = yield* ReviewPublisher;
  const memorySink = yield* MemoryCandidateSink;
  const config = yield* ReviewEngineConfig;
  const contexts = yield* ReviewRunContexts;

  const submit: ReviewEngineShape["submit"] = Effect.fn("ReviewEngine.submit")(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* store.enqueue({ ...input, now });
  });

  const emitMemoryCandidates = Effect.fn("ReviewEngine.emitMemoryCandidates")(function* (
    job: ReviewJob,
    verdict: GateVerdict,
  ) {
    yield* memorySink.offer({
      source: "review",
      repo: job.repo,
      headSha: job.headSha,
      kind: "verdict",
      text: `Review verdict ${verdict.decision}: ${verdict.reasons.join(" ")}`,
    });
    for (const finding of verdict.followups) {
      yield* memorySink.offer({
        source: "review",
        repo: job.repo,
        headSha: job.headSha,
        kind: "finding",
        text: finding.summary,
        severity: finding.severity,
      });
    }
  });

  const processNext: ReviewEngineShape["processNext"] = Effect.fn("ReviewEngine.processNext")(
    function* () {
      const settings = yield* config.current;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);

      const hourAgo = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
      const startedInLastHour = yield* store.countStartedSince(hourAgo);
      if (startedInLastHour >= settings.hourlyQuota) {
        return { kind: "quota-exhausted", startedInLastHour } as const;
      }

      const eligible = yield* store.nextEligible(nowIso);
      if (Option.isNone(eligible)) {
        return { kind: "idle" } as const;
      }

      const job = yield* store.transition({
        id: eligible.value.id,
        from: "queued",
        to: "reviewing",
        now: nowIso,
        set: {
          attempts: eligible.value.attempts + 1,
          lastStartedAt: nowIso,
          // A new attempt starts clean: the previous attempt's cooldown and
          // failure detail are stale the moment this one begins.
          cooldownUntil: null,
          failureReason: null,
        },
      });

      const context = yield* contexts.resolve(job);

      // One scheduler key per repo, so a repo's legs stay on the instance it
      // used last instead of rotating accounts leg by leg.
      const schedulerProjectId = ProjectId.make(reviewSchedulerProjectKey(job.repo));
      const legOutcomes = yield* Effect.forEach(context.legs, (legConfig) =>
        legRunner
          .run(
            legConfig,
            buildLegBrief(legConfig, { ...context.brief, playbook: context.playbook }),
            { projectId: schedulerProjectId },
          )
          .pipe(
            Effect.map((result) => ({
              _tag: "ran" as const,
              parsed: parseLegOutput(legConfig.role, result.rawOutput),
            })),
            Effect.catchTag("NomiorLegRunError", (error) =>
              Effect.succeed({ _tag: "run-failed" as const, error }),
            ),
          ),
      );

      const runFailures = legOutcomes.flatMap((outcome) =>
        outcome._tag === "run-failed" ? [outcome.error] : [],
      );
      if (runFailures.length > 0) {
        const rateLimited = runFailures.some((failure) => failure.rateLimited);
        const detail = runFailures.map((failure) => failure.detail).join("; ");

        if (job.attempts >= settings.maxAttempts) {
          const failed = yield* store.transition({
            id: job.id,
            from: "reviewing",
            to: "failed",
            now: nowIso,
            set: { failureReason: `Gave up after ${job.attempts} attempts: ${detail}` },
          });
          return { kind: "failed", job: failed } as const;
        }

        // Exponential backoff on the attempt count; rate-limit failures use
        // a much longer base so a throttled instance is left alone.
        const baseSeconds = rateLimited
          ? settings.rateLimitCooldownSeconds
          : settings.cooldownBaseSeconds;
        const cooldownSeconds = baseSeconds * 2 ** Math.max(0, job.attempts - 1);
        const cooldownUntil = DateTime.formatIso(DateTime.add(now, { seconds: cooldownSeconds }));
        const requeued = yield* store.transition({
          id: job.id,
          from: "reviewing",
          to: "queued",
          now: nowIso,
          set: { cooldownUntil, failureReason: detail },
        });
        return { kind: "retry-scheduled", job: requeued, cooldownUntil } as const;
      }

      const parsedLegs: ReadonlyArray<ParsedLegResult> = legOutcomes.flatMap((outcome) =>
        outcome._tag === "ran" ? [outcome.parsed] : [],
      );

      // Escalation is a request, not an override: a leg that reports a
      // blocking finding (or output the parser could not read) and asks for a
      // human in the same breath is still a blocked review. The gate decides
      // first, so `needsExternalReview` can never route a critical finding
      // past it into a human resolution that never sees the finding.
      const escalationRequested = parsedLegs.some(
        (leg) => leg.outcome === "parsed" && leg.report.needsExternalReview,
      );
      if (escalationRequested && !hasBlockingFindings(parsedLegs)) {
        const waiting = yield* store.transition({
          id: job.id,
          from: "reviewing",
          to: "waiting-external",
          now: nowIso,
        });
        return { kind: "waiting-external", job: waiting } as const;
      }

      const verdict = evaluateGate({ legs: parsedLegs, playbook: context.playbook });
      const terminal = verdict.decision === "not-approved" ? "not-approved" : "approved";
      const completed = yield* store.transition({
        id: job.id,
        from: "reviewing",
        to: terminal,
        now: nowIso,
        set: { verdict: verdict.decision },
      });

      const publish: PublishReceipt = settings.allowExternalPosting
        ? yield* publisher.publish({ job: completed, verdict })
        : {
            posted: false,
            detail: "external posting is not approved (allowExternalPosting=false)",
          };

      yield* emitMemoryCandidates(completed, verdict);

      return { kind: "completed", job: completed, verdict, publish } as const;
    },
  );

  const resolveExternal: ReviewEngineShape["resolveExternal"] = Effect.fn(
    "ReviewEngine.resolveExternal",
  )(function* (id, decision, note) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* store.transition({
      id,
      from: "waiting-external",
      to: decision,
      now: nowIso,
      set: {
        verdict: decision === "approved" ? "approve" : "not-approved",
        failureReason: note,
      },
    });
  });

  return ReviewEngine.of({ submit, processNext, resolveExternal });
});

export const layer = Layer.effect(ReviewEngine, make);
