/**
 * Wire shapes for the Nomior panels (review board, context & memory, calendar,
 * instances).
 *
 * These mirror the panel domain types in `apps/web/src/nomior/types.ts` so the
 * RPC-backed data port is a thin adapter rather than a translation layer. Where
 * a server-side shape differs from what a panel renders — the review engine's
 * `queued`/`failed` statuses, its three-way gate verdict — the mapping is the
 * handler's job, and the difference is called out on the field.
 *
 * Nothing here carries a provider credential: instance headroom is derived from
 * rate-limit events the provider itself reports, and accounts are identified by
 * the address the user signed in with. See `docs/nomior/WORKING-RULES.md`.
 *
 * @module nomior
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// ---------------------------------------------------------------------------
// Review board
// ---------------------------------------------------------------------------

/**
 * The board's five columns. The engine also has `queued` and `failed`; the
 * handler folds `queued` into `queue` and hides `failed` jobs, which are an
 * operational state rather than a review outcome.
 */
export const NomiorReviewJobStatus = Schema.Literals([
  "queue",
  "reviewing",
  "waiting-external",
  "approved",
  "not-approved",
]);
export type NomiorReviewJobStatus = typeof NomiorReviewJobStatus.Type;

export const NomiorReviewRiskTier = Schema.Literals(["low", "medium", "high"]);
export type NomiorReviewRiskTier = typeof NomiorReviewRiskTier.Type;

/**
 * What the board shows. The gate's `approve-with-followups` reports as
 * `approved` — followups are findings, and the card already renders those.
 */
export const NomiorReviewVerdict = Schema.Literals(["approved", "not-approved"]);
export type NomiorReviewVerdict = typeof NomiorReviewVerdict.Type;

export const NomiorReviewSeverityCounts = Schema.Struct({
  blocker: NonNegativeInt,
  major: NonNegativeInt,
  minor: NonNegativeInt,
});
export type NomiorReviewSeverityCounts = typeof NomiorReviewSeverityCounts.Type;

export const NomiorReviewJob = Schema.Struct({
  id: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  pullRequestNumber: Schema.Int,
  pullRequestTitle: Schema.String,
  riskTier: NomiorReviewRiskTier,
  status: NomiorReviewJobStatus,
  /** Null until a review leg has produced a verdict. */
  verdict: Schema.NullOr(NomiorReviewVerdict),
  severityCounts: NomiorReviewSeverityCounts,
  manualReviewRequested: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type NomiorReviewJob = typeof NomiorReviewJob.Type;

export const NomiorReviewJobsListResult = Schema.Struct({
  jobs: Schema.Array(NomiorReviewJob),
});
export type NomiorReviewJobsListResult = typeof NomiorReviewJobsListResult.Type;

export const NomiorReviewRequestManualInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type NomiorReviewRequestManualInput = typeof NomiorReviewRequestManualInput.Type;

// ---------------------------------------------------------------------------
// Context & memory
// ---------------------------------------------------------------------------

/**
 * The retrieval port's own source kinds (`ContextSourceKind` in
 * `apps/server/src/nomior/context/RetrievalPort.ts`). Kept identical to the
 * engine's vocabulary rather than a friendlier invented one, so a snippet
 * never has to be relabelled on the way to the panel.
 */
export const NomiorContextSourceKind = Schema.Literals([
  "meeting",
  "decision",
  "memory",
  "document",
  "mail",
  "event",
]);
export type NomiorContextSourceKind = typeof NomiorContextSourceKind.Type;

export const NomiorContextSnippet = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceTitle: Schema.String,
  sourceKind: NomiorContextSourceKind,
  /** ISO date of the source material, not of the query. */
  sourceDate: Schema.String,
  /** Evidence excerpt from the broker, already budget-bounded. */
  excerpt: Schema.String,
  /** Retrieval score in [0, 1], for ordering only — never shown raw. */
  score: Schema.Number,
});
export type NomiorContextSnippet = typeof NomiorContextSnippet.Type;

export const NomiorContextSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type NomiorContextSearchInput = typeof NomiorContextSearchInput.Type;

export const NomiorContextSearchResult = Schema.Struct({
  snippets: Schema.Array(NomiorContextSnippet),
});
export type NomiorContextSearchResult = typeof NomiorContextSearchResult.Type;

export const NomiorMemoryCandidateStatus = Schema.Literals(["pending", "approved", "rejected"]);
export type NomiorMemoryCandidateStatus = typeof NomiorMemoryCandidateStatus.Type;

export const NomiorMemoryCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  /** Where it was extracted from (a review finding, a meeting, a document). */
  source: Schema.String,
  capturedAt: IsoDateTime,
  status: NomiorMemoryCandidateStatus,
});
export type NomiorMemoryCandidate = typeof NomiorMemoryCandidate.Type;

export const NomiorMemoryCandidatesListResult = Schema.Struct({
  candidates: Schema.Array(NomiorMemoryCandidate),
});
export type NomiorMemoryCandidatesListResult = typeof NomiorMemoryCandidatesListResult.Type;

export const NomiorMemoryCandidateResolveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  resolution: Schema.Literals(["approved", "rejected"]),
});
export type NomiorMemoryCandidateResolveInput = typeof NomiorMemoryCandidateResolveInput.Type;

// ---------------------------------------------------------------------------
// Calendar & meetings
// ---------------------------------------------------------------------------

export const NomiorCalendarAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  email: Schema.String,
  /** Stable index into the shared account colour palette. */
  colorIndex: NonNegativeInt,
});
export type NomiorCalendarAccount = typeof NomiorCalendarAccount.Type;

export const NomiorMeetingArtifacts = Schema.Struct({
  meetingId: TrimmedNonEmptyString,
  hasTranscript: Schema.Boolean,
  hasNotes: Schema.Boolean,
});
export type NomiorMeetingArtifacts = typeof NomiorMeetingArtifacts.Type;

export const NomiorCalendarEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  title: Schema.String,
  start: IsoDateTime,
  end: IsoDateTime,
  /** Google `recurringEventId`; events sharing one belong to a series. */
  recurringSeriesId: Schema.NullOr(Schema.String),
  meeting: Schema.NullOr(NomiorMeetingArtifacts),
});
export type NomiorCalendarEvent = typeof NomiorCalendarEvent.Type;

export const NomiorCalendarAccountsListResult = Schema.Struct({
  accounts: Schema.Array(NomiorCalendarAccount),
});
export type NomiorCalendarAccountsListResult = typeof NomiorCalendarAccountsListResult.Type;

export const NomiorCalendarEventsListInput = Schema.Struct({
  /** Half-open window [rangeStart, rangeEnd). */
  rangeStart: IsoDateTime,
  rangeEnd: IsoDateTime,
});
export type NomiorCalendarEventsListInput = typeof NomiorCalendarEventsListInput.Type;

export const NomiorCalendarEventsListResult = Schema.Struct({
  events: Schema.Array(NomiorCalendarEvent),
});
export type NomiorCalendarEventsListResult = typeof NomiorCalendarEventsListResult.Type;

// ---------------------------------------------------------------------------
// Instances & scheduler
// ---------------------------------------------------------------------------

export const NomiorInstanceHealth = Schema.Literals(["healthy", "throttled", "signed-out"]);
export type NomiorInstanceHealth = typeof NomiorInstanceHealth.Type;

export const NomiorProviderInstance = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  /** Provider driver name as shown to the user (Claude, Codex, …). */
  provider: Schema.String,
  health: NomiorInstanceHealth,
  /** A manual pin outranks every scheduler signal. */
  pinned: Schema.Boolean,
  /** Rate-limit headroom in [0, 1] when the provider reported one. */
  headroom: Schema.NullOr(Schema.Number),
});
export type NomiorProviderInstance = typeof NomiorProviderInstance.Type;

export const NomiorInstancesListResult = Schema.Struct({
  instances: Schema.Array(NomiorProviderInstance),
});
export type NomiorInstancesListResult = typeof NomiorInstancesListResult.Type;

export const NomiorInstanceSetPinnedInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  pinned: Schema.Boolean,
});
export type NomiorInstanceSetPinnedInput = typeof NomiorInstanceSetPinnedInput.Type;

export const NomiorSchedulerDecision = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  /** The explicit reason the scheduler surfaced for this pick. */
  reason: Schema.String,
  decidedAt: IsoDateTime,
});
export type NomiorSchedulerDecision = typeof NomiorSchedulerDecision.Type;

export const NomiorSchedulerState = Schema.Struct({
  lastDecision: Schema.NullOr(NomiorSchedulerDecision),
  /** Advisory mode: the scheduler suggests but never switches on its own. */
  advisoryMode: Schema.Boolean,
});
export type NomiorSchedulerState = typeof NomiorSchedulerState.Type;

export const NomiorSetAdvisoryModeInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type NomiorSetAdvisoryModeInput = typeof NomiorSetAdvisoryModeInput.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error for the whole surface. The panels render a retryable message and
 * never branch on the cause, so splitting this per method would add wire types
 * nothing reads. `retryable: false` marks a request that will fail the same way
 * again — a rejected scope, an unknown id — so the UI can drop its Retry.
 */
export class NomiorRequestError extends Schema.TaggedErrorClass<NomiorRequestError>()(
  "NomiorRequestError",
  {
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  },
) {}
