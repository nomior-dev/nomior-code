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
// Meetings
// ---------------------------------------------------------------------------

/** One person in the room. Anarlog often knows a name or an email, not both. */
export const NomiorMeetingParticipant = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
export type NomiorMeetingParticipant = typeof NomiorMeetingParticipant.Type;

/**
 * A meeting as the list renders it. `endedAt` is not stored by the broker, so
 * duration is derived from the last transcript turn and is null for a meeting
 * whose transcript is still empty.
 */
export const NomiorMeeting = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  /** ISO timestamp the meeting started, when the connector knew one. */
  startedAt: Schema.NullOr(IsoDateTime),
  /**
   * Milliseconds from the recording's start to its last timed turn. Recorders
   * do not persist an end time, so this is derived and reads slightly short of
   * the true length. Null when no turn carried a timestamp.
   */
  durationMs: Schema.NullOr(Schema.Int),
  participants: Schema.Array(NomiorMeetingParticipant),
  turnCount: Schema.Int,
  hasNotes: Schema.Boolean,
  /** Links the meeting to its calendar event, when the connector matched one. */
  calendarEventId: Schema.NullOr(Schema.String),
});
export type NomiorMeeting = typeof NomiorMeeting.Type;

/**
 * One speaker turn. `speaker` is null when diarization never assigned one;
 * offsets are milliseconds from the start of the recording, and are null for a
 * transcript the connector delivered without timing (the markdown fallback).
 */
export const NomiorTranscriptTurn = Schema.Struct({
  id: TrimmedNonEmptyString,
  ordinal: Schema.Int,
  speaker: Schema.NullOr(Schema.String),
  startMs: Schema.NullOr(Schema.Int),
  endMs: Schema.NullOr(Schema.Int),
  text: Schema.String,
});
export type NomiorTranscriptTurn = typeof NomiorTranscriptTurn.Type;

export const NomiorMeetingDetail = Schema.Struct({
  meeting: NomiorMeeting,
  transcript: Schema.Array(NomiorTranscriptTurn),
  /** The linked notes document, joined on the session id. Null when absent. */
  notes: Schema.NullOr(Schema.String),
});
export type NomiorMeetingDetail = typeof NomiorMeetingDetail.Type;

export const NomiorMeetingsListInput = Schema.Struct({
  /** Half-open ISO window on the meeting start; omit for the most recent. */
  rangeStart: Schema.optional(IsoDateTime),
  rangeEnd: Schema.optional(IsoDateTime),
});
export type NomiorMeetingsListInput = typeof NomiorMeetingsListInput.Type;

export const NomiorMeetingsListResult = Schema.Struct({
  meetings: Schema.Array(NomiorMeeting),
});
export type NomiorMeetingsListResult = typeof NomiorMeetingsListResult.Type;

export const NomiorMeetingGetInput = Schema.Struct({
  meetingId: TrimmedNonEmptyString,
});
export type NomiorMeetingGetInput = typeof NomiorMeetingGetInput.Type;

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * Which connector a row is for. Mirrors the server's `ConnectorDriverKind`
 * values rather than re-deriving them. A stored row whose driver is not listed
 * here is dropped with a warning rather than failing the encode — one stale row
 * must not blank the whole panel.
 */
export const NomiorConnectorKind = Schema.Literals(["googleCalendar", "gmail", "anarlog"]);
export type NomiorConnectorKind = typeof NomiorConnectorKind.Type;

/** `error` and `revoked` are distinct: one may recover on retry, one needs a reconnect. */
export const NomiorConnectorStatus = Schema.Literals(["connected", "error", "revoked"]);
export type NomiorConnectorStatus = typeof NomiorConnectorStatus.Type;

export const NomiorConnectorAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: NomiorConnectorKind,
  /** The account's own name for itself — an address for Google, a path for Anarlog. */
  displayName: Schema.String,
  status: NomiorConnectorStatus,
  /** Null until the first sync completes; the panel says "never" rather than guessing. */
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  /** Present only on `error`/`revoked`, and already redacted. */
  detail: Schema.NullOr(Schema.String),
});
export type NomiorConnectorAccount = typeof NomiorConnectorAccount.Type;

/**
 * Whether this environment can start a Google OAuth flow at all.
 *
 * The flow is PKCE against a client id the operator supplies; there is no
 * bundled one, so `configured: false` is the normal first-run state and the
 * panel must offer the field rather than a dead Connect button.
 */
export const NomiorGoogleClientState = Schema.Struct({
  configured: Schema.Boolean,
  /**
   * Where the id in use came from. `bundled` is the normal case in a release
   * build and needs no setup UI at all; `operator` means someone pointed this
   * environment at their own Google Cloud project; `none` is a source checkout
   * or fork with neither, and is the only state that must ask for anything.
   */
  source: Schema.Literals(["bundled", "operator", "none"]),
  /** Last four characters only — enough to tell two ids apart, useless if leaked. */
  clientIdHint: Schema.NullOr(Schema.String),
});
export type NomiorGoogleClientState = typeof NomiorGoogleClientState.Type;

/**
 * Where the Anarlog desktop app's local store is, if it is on this machine.
 *
 * `unsupportedSchema` is its own state on purpose: the reader pins a schema
 * ceiling, so a newer Anarlog is a thing we detected and refuse to misread,
 * not a thing we failed to find.
 */
export const NomiorAnarlogState = Schema.Struct({
  detection: Schema.Literals(["found", "notFound", "unsupportedSchema"]),
  /** Absolute path when `found`, else null. */
  storePath: Schema.NullOr(Schema.String),
  /** Set when `unsupportedSchema`, so the message can name the version. */
  schemaVersion: Schema.NullOr(Schema.Int),
});
export type NomiorAnarlogState = typeof NomiorAnarlogState.Type;

export const NomiorConnectorsListResult = Schema.Struct({
  accounts: Schema.Array(NomiorConnectorAccount),
  google: NomiorGoogleClientState,
  anarlog: NomiorAnarlogState,
  /**
   * False when the client is talking to a server on another machine. The OAuth
   * flow binds a loopback listener on the *server's* host, so a remote browser
   * cannot complete it; the panel says so instead of opening a URL that will
   * hang.
   */
  canStartLocalOAuth: Schema.Boolean,
});
export type NomiorConnectorsListResult = typeof NomiorConnectorsListResult.Type;

export const NomiorGoogleClientIdSetInput = Schema.Struct({
  /** Empty string clears it, which is how the operator revokes the whole flow. */
  clientId: Schema.String,
});
export type NomiorGoogleClientIdSetInput = typeof NomiorGoogleClientIdSetInput.Type;

export const NomiorConnectorConnectInput = Schema.Struct({
  kind: NomiorConnectorKind,
});
export type NomiorConnectorConnectInput = typeof NomiorConnectorConnectInput.Type;

/**
 * The URL to open, when there is one. The server has already started listening
 * for the redirect, so the client's only job is to open this and then re-list.
 *
 * Null means the connector is already connected and no browser step exists:
 * Anarlog is a local store this machine either has or does not, so connecting
 * it records the detected path rather than sending anyone to a consent screen.
 */
export const NomiorConnectorConnectResult = Schema.Struct({
  authorizationUrl: Schema.NullOr(Schema.String),
});
export type NomiorConnectorConnectResult = typeof NomiorConnectorConnectResult.Type;

export const NomiorConnectorAccountInput = Schema.Struct({
  accountId: TrimmedNonEmptyString,
});
export type NomiorConnectorAccountInput = typeof NomiorConnectorAccountInput.Type;

export const NomiorConnectorSyncResult = Schema.Struct({
  /** Sources written or refreshed by this run, so the panel can say what changed. */
  ingested: NonNegativeInt,
});
export type NomiorConnectorSyncResult = typeof NomiorConnectorSyncResult.Type;

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
