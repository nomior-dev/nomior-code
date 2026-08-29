/**
 * Wire and persistence shapes for the Nomior review engine.
 *
 * The engine is a state machine over a persisted job table
 * (`nomior_review_jobs`): Queue → Reviewing → WaitingExternal → Approved /
 * NotApproved / Failed, with idempotent receipts keyed by (repo, target,
 * head sha). See PLAN.md "Review engine".
 */
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ReviewJobId = TrimmedNonEmptyString.pipe(Schema.brand("NomiorReviewJobId"));
export type ReviewJobId = typeof ReviewJobId.Type;

export const ReviewJobStatus = Schema.Literals([
  "queued",
  "reviewing",
  "waiting-external",
  "approved",
  "not-approved",
  "failed",
]);
export type ReviewJobStatus = typeof ReviewJobStatus.Type;

export const ReviewRiskTier = Schema.Literals(["low", "medium", "high"]);
export type ReviewRiskTier = typeof ReviewRiskTier.Type;

/**
 * Where the reviewed pull request stands, which is independent of where its
 * review stands: a review can still be waiting on a human long after the pull
 * request merged. The board lists `open` only.
 */
export const ReviewPullRequestState = Schema.Literals(["open", "merged", "closed"]);
export type ReviewPullRequestState = typeof ReviewPullRequestState.Type;

/** What a review job reviews: a forge pull request or an agent thread's work. */
export const ReviewTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
  }),
]);
export type ReviewTarget = typeof ReviewTarget.Type;

export const GateDecision = Schema.Literals(["approve", "approve-with-followups", "not-approved"]);
export type GateDecision = typeof GateDecision.Type;

export const ReviewJob = Schema.Struct({
  id: ReviewJobId,
  repo: TrimmedNonEmptyString,
  target: ReviewTarget,
  headSha: TrimmedNonEmptyString,
  status: ReviewJobStatus,
  pullRequestState: ReviewPullRequestState,
  riskTier: ReviewRiskTier,
  attempts: NonNegativeInt,
  cooldownUntil: Schema.NullOr(IsoDateTime),
  lastStartedAt: Schema.NullOr(IsoDateTime),
  failureReason: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(GateDecision),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ReviewJob = typeof ReviewJob.Type;

/**
 * Legal state-machine transitions. Everything else is a bug, enforced by
 * `ReviewJobStore.transition` with a compare-and-swap on the current status.
 */
export const REVIEW_JOB_TRANSITIONS: Record<ReviewJobStatus, ReadonlyArray<ReviewJobStatus>> = {
  queued: ["reviewing"],
  reviewing: ["approved", "not-approved", "waiting-external", "queued", "failed"],
  "waiting-external": ["approved", "not-approved"],
  approved: [],
  "not-approved": [],
  failed: [],
};

export const isAllowedTransition = (from: ReviewJobStatus, to: ReviewJobStatus): boolean =>
  REVIEW_JOB_TRANSITIONS[from].includes(to);

export const FindingSeverity = Schema.Literals(["critical", "high", "medium", "low", "info"]);
export type FindingSeverity = typeof FindingSeverity.Type;

export const LegFinding = Schema.Struct({
  severity: FindingSeverity,
  summary: TrimmedNonEmptyString,
  file: Schema.optional(TrimmedNonEmptyString),
  line: Schema.optional(Schema.Int),
});
export type LegFinding = typeof LegFinding.Type;

/**
 * Evidence that the change was actually exercised, not just read. The gate
 * refuses to approve without at least one entry — a review with zero runtime
 * evidence is an opinion, not a verification.
 */
export const RuntimeEvidence = Schema.Struct({
  kind: Schema.Literals([
    "tests-run",
    "build-passed",
    "typecheck-passed",
    "live-probe",
    "ci-green",
  ]),
  detail: TrimmedNonEmptyString,
});
export type RuntimeEvidence = typeof RuntimeEvidence.Type;

export const ReviewLegRole = Schema.Literals(["claude-verify", "codex-read", "security"]);
export type ReviewLegRole = typeof ReviewLegRole.Type;

/**
 * The structured report a leg must emit (as a JSON object in its output).
 *
 * `findings` is deliberately required: Effect Schema ignores excess keys, so
 * with every field defaulted ANY object (an incidental brace-expression in
 * prose, a code snippet) would decode as a clean empty report and count as a
 * passing leg. Requiring `findings` keeps parsing fail-closed — a leg with
 * nothing to report must still say `"findings": []`, as its brief instructs.
 */
export const LegReport = Schema.Struct({
  findings: Schema.Array(LegFinding),
  runtimeEvidence: Schema.Array(RuntimeEvidence).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  needsExternalReview: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type LegReport = typeof LegReport.Type;

/**
 * A leg's output after parsing. `unparseable` is a first-class outcome: the
 * gate treats it as a high-severity finding and fails closed.
 */
export const ParsedLegResult = Schema.Union([
  Schema.Struct({
    legRole: ReviewLegRole,
    outcome: Schema.Literal("parsed"),
    report: LegReport,
  }),
  Schema.Struct({
    legRole: ReviewLegRole,
    outcome: Schema.Literal("unparseable"),
    detail: Schema.String,
  }),
]);
export type ParsedLegResult = typeof ParsedLegResult.Type;

export const GateVerdict = Schema.Struct({
  decision: GateDecision,
  /** Why the gate decided what it decided, in UI-ready sentences. */
  reasons: Schema.Array(Schema.String),
  /** Non-blocking findings to carry forward when approving with followups. */
  followups: Schema.Array(LegFinding),
});
export type GateVerdict = typeof GateVerdict.Type;
