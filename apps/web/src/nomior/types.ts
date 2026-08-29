/**
 * Nomior panel domain types.
 *
 * These are the client-side shapes the Nomior panels render. They stay
 * structurally identical to the `Nomior*` wire types in `@t3tools/contracts`,
 * which is what lets `rpcPort.ts` unwrap a response envelope and hand the
 * result straight to a panel; the port's return annotations turn any future
 * divergence into a build error rather than a runtime surprise.
 *
 * @module nomior/types
 */

// ---------------------------------------------------------------------------
// Review board
// ---------------------------------------------------------------------------

/** Mirrors the review engine's state machine (PLAN.md, "Review board"). */
export type ReviewJobStatus =
  | "queue"
  | "reviewing"
  | "waiting-external"
  | "approved"
  | "not-approved";

export type ReviewRiskTier = "low" | "medium" | "high";

export type ReviewVerdict = "approved" | "not-approved";

export interface ReviewSeverityCounts {
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
}

export interface ReviewJob {
  readonly id: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly riskTier: ReviewRiskTier;
  readonly status: ReviewJobStatus;
  /** Null until a review leg has produced a verdict. */
  readonly verdict: ReviewVerdict | null;
  readonly severityCounts: ReviewSeverityCounts;
  readonly manualReviewRequested: boolean;
  /** ISO timestamp of the job's last state change. */
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Context & memory
// ---------------------------------------------------------------------------

/** Mirrors the retrieval port's source kinds; the engine owns this vocabulary. */
export type ContextSourceKind = "meeting" | "decision" | "memory" | "document" | "mail" | "event";

export interface ContextSnippet {
  readonly id: string;
  readonly sourceTitle: string;
  readonly sourceKind: ContextSourceKind;
  /** ISO date of the source material, not of the query. */
  readonly sourceDate: string;
  /** The evidence excerpt returned by the broker, already budget-bounded. */
  readonly excerpt: string;
  /** Retrieval score in [0, 1], for ordering only — never shown raw. */
  readonly score: number;
}

export type MemoryCandidateResolution = "approved" | "rejected";

export interface MemoryCandidate {
  readonly id: string;
  readonly text: string;
  /** Where the candidate was extracted from (review finding, meeting, …). */
  readonly source: string;
  readonly capturedAt: string;
  /** Pending candidates await an explicit user decision; nothing auto-promotes. */
  readonly status: "pending" | MemoryCandidateResolution;
}

// ---------------------------------------------------------------------------
// Calendar & meetings
// ---------------------------------------------------------------------------

export interface CalendarAccount {
  readonly id: string;
  readonly email: string;
  /** Stable index into the shared account color palette. */
  readonly colorIndex: number;
}

export interface CalendarEventItem {
  readonly id: string;
  readonly accountId: string;
  readonly title: string;
  /** ISO timestamps. */
  readonly start: string;
  readonly end: string;
  /** Google `recurringEventId`; events sharing one belong to a series. */
  readonly recurringSeriesId: string | null;
  /** Present when the meeting has captured artifacts to open. */
  readonly meeting: MeetingArtifacts | null;
}

export interface MeetingArtifacts {
  readonly meetingId: string;
  readonly hasTranscript: boolean;
  readonly hasNotes: boolean;
}

// ---------------------------------------------------------------------------
// Instances & scheduler
// ---------------------------------------------------------------------------

export type InstanceHealth = "healthy" | "throttled" | "signed-out";

export interface ProviderInstanceItem {
  readonly id: string;
  readonly label: string;
  /** Provider driver name as shown to the user (Claude, Codex, …). */
  readonly provider: string;
  readonly health: InstanceHealth;
  /** Manual pin wins over every scheduler signal. */
  readonly pinned: boolean;
  /** Rate-limit headroom in [0, 1] when the provider stream reported one. */
  readonly headroom: number | null;
}

export interface SchedulerDecision {
  readonly instanceId: string;
  /** The explicit reason the scheduler surfaced for this pick. */
  readonly reason: string;
  readonly decidedAt: string;
}

export interface SchedulerState {
  readonly lastDecision: SchedulerDecision | null;
  /** Advisory mode: the scheduler suggests but never switches on its own. */
  readonly advisoryMode: boolean;
}
