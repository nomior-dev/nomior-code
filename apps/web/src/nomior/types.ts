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

/** One person in the room. Anarlog often knows a name or an email, not both. */
export interface MeetingParticipant {
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * A meeting as the list renders it. The broker stores no end time, so duration
 * is derived from the transcript and is null for a meeting that produced none.
 */
export interface MeetingItem {
  readonly id: string;
  readonly title: string;
  /** ISO timestamp; null when the connector never knew a start time. */
  readonly startedAt: string | null;
  /** Milliseconds from the first turn to the last; null when there are none. */
  readonly durationMs: number | null;
  readonly participants: readonly MeetingParticipant[];
  readonly turnCount: number;
  readonly hasNotes: boolean;
  /** Set when the connector matched the meeting to a calendar event. */
  readonly calendarEventId: string | null;
}

/**
 * One speaker turn. `speaker` is null when diarization never assigned one;
 * offsets are milliseconds from the start of the recording, and are null for a
 * transcript the connector delivered without timing (the markdown fallback).
 */
export interface TranscriptTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly speaker: string | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly text: string;
}

export interface MeetingDetail {
  readonly meeting: MeetingItem;
  readonly transcript: readonly TranscriptTurn[];
  /** The linked notes document. Null when the meeting has none. */
  readonly notes: string | null;
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

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export type ConnectorKind = "googleCalendar" | "gmail" | "anarlog";

/** `error` may clear on retry; `revoked` needs the account connected again. */
export type ConnectorStatus = "connected" | "error" | "revoked";

export interface ConnectorAccountItem {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly status: ConnectorStatus;
  /** Null until a first sync finishes, which the panel renders as "never". */
  readonly lastSyncedAt: string | null;
  /** Only on `error`/`revoked`, already redacted server-side. */
  readonly detail: string | null;
}

export interface GoogleClientState {
  readonly configured: boolean;
  /** Last four characters, enough to tell two ids apart. */
  readonly clientIdHint: string | null;
}

/**
 * `unsupportedSchema` is separate from `notFound` on purpose: the reader pins a
 * schema ceiling, so a newer Anarlog is detected-and-refused rather than absent.
 */
export type AnarlogDetection = "found" | "notFound" | "unsupportedSchema";

export interface AnarlogState {
  readonly detection: AnarlogDetection;
  readonly storePath: string | null;
  readonly schemaVersion: number | null;
}

export interface ConnectorsOverview {
  readonly accounts: readonly ConnectorAccountItem[];
  readonly google: GoogleClientState;
  readonly anarlog: AnarlogState;
  /**
   * False when this client is not on the server's machine. The OAuth redirect
   * lands on a loopback listener bound on the *server's* host, so a remote
   * browser cannot finish the flow.
   */
  readonly canStartLocalOAuth: boolean;
}
