/**
 * Handlers for the review-board, calendar and instances RPC methods.
 *
 * Kept out of `ws.ts` so the fork's touch on that upstream file stays a single
 * spread. Each handler converts its service's typed failures into the one wire
 * error the panels understand, and each takes its services as arguments so it
 * can be tested without building a layer graph.
 *
 * @module nomior/rpc/panelHandlers
 */
import {
  NomiorRequestError,
  type NomiorCalendarAccount,
  type NomiorCalendarEvent,
  type NomiorReviewJob,
  type NomiorReviewJobDetail,
  type NomiorSchedulerState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ConnectorAccountStore } from "../connectors/ConnectorAccountStore.ts";
import { GOOGLE_CALENDAR_DRIVER_KIND } from "../connectors/Records.ts";
import type {
  CalendarEventStore,
  StoredCalendarEvent,
} from "../connectors/calendar/CalendarEventStore.ts";
import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";
import type { RateLimitObserverShape } from "../scheduler/RateLimitObserver.ts";
import type { SchedulerPreferencesShape } from "../scheduler/SchedulerPreferences.ts";
import { toPanelInstances, type PanelInstanceInput } from "../scheduler/panelInstances.ts";
import { ReviewJobId } from "../review/Schemas.ts";
import type { ReviewJobBoardRow, ReviewJobStoreShape } from "../review/ReviewJobStore.ts";

/** How much of the board to load. Far above any realistic column height. */
const REVIEW_BOARD_LIMIT = 200;

const failed = (fallback: string, retryable: boolean) => (cause: unknown) =>
  new NomiorRequestError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallback,
    retryable,
  });

// ---------------------------------------------------------------------------
// Review board
// ---------------------------------------------------------------------------

/**
 * `queued` is the engine's name for the board's first column. `failed` never
 * arrives here — `listRecent` drops those, since the board has no column for a
 * job that never produced a verdict.
 */
const toWireStatus = (status: ReviewJobBoardRow["status"]): NomiorReviewJob["status"] | null => {
  switch (status) {
    case "queued":
      return "queue";
    case "reviewing":
    case "waiting-external":
    case "approved":
    case "not-approved":
      return status;
    case "failed":
      return null;
  }
};

/**
 * The gate's `approve-with-followups` shows as approved: the followups are
 * findings, and the job's page renders the severity tally.
 */
const toWireVerdict = (verdict: ReviewJobBoardRow["verdict"]): NomiorReviewJobDetail["verdict"] => {
  if (verdict === null) return null;
  return verdict === "not-approved" ? "not-approved" : "approved";
};

const toWireReviewJob = (row: ReviewJobBoardRow): NomiorReviewJob | null => {
  const status = toWireStatus(row.status);
  // The board is per pull request; a thread-targeted review has no card.
  if (status === null || row.target.kind !== "pull-request") return null;
  return {
    id: row.id,
    repo: row.repo,
    pullRequestNumber: row.target.number,
    pullRequestTitle: row.title ?? "",
    status,
    updatedAt: row.updatedAt,
  };
};

/** The card's facts plus everything the engine knows, for one job's own page. */
const toWireReviewJobDetail = (row: ReviewJobBoardRow): NomiorReviewJobDetail | null => {
  const job = toWireReviewJob(row);
  if (job === null) return null;
  return {
    ...job,
    pullRequestState: row.pullRequestState,
    riskTier: row.riskTier,
    verdict: toWireVerdict(row.verdict),
    severityCounts: row.severityCounts,
    manualReviewRequested: row.manualReviewRequestedAt !== null,
    headSha: row.headSha,
    createdAt: row.createdAt,
  };
};

export const listReviewJobs = Effect.fn("nomior.rpc.listReviewJobs")(function* (
  store: ReviewJobStoreShape,
) {
  const rows = yield* store
    .listRecent(REVIEW_BOARD_LIMIT)
    .pipe(Effect.mapError(failed("Review jobs are unavailable.", true)));
  const jobs: Array<NomiorReviewJob> = [];
  for (const row of rows) {
    const job = toWireReviewJob(row);
    if (job !== null) jobs.push(job);
  }
  return { jobs };
});

export const getReviewJob = Effect.fn("nomior.rpc.getReviewJob")(function* (
  store: ReviewJobStoreShape,
  input: { readonly jobId: string },
) {
  const row = yield* store
    .getBoardRow(ReviewJobId.make(input.jobId))
    .pipe(Effect.mapError(failed("This review is unavailable.", true)));
  const detail = Option.isSome(row) ? toWireReviewJobDetail(row.value) : null;
  if (detail === null) {
    // Either there is no such job, or it is one the board never had a card for
    // (a failed run, or a review of a thread rather than a pull request).
    return yield* new NomiorRequestError({
      message: `No review for id ${input.jobId}.`,
      retryable: false,
    });
  }
  return detail;
});

export const requestManualReview = Effect.fn("nomior.rpc.requestManualReview")(function* (
  store: ReviewJobStoreShape,
  input: { readonly jobId: string },
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* store.requestManualReview(ReviewJobId.make(input.jobId), now).pipe(
    Effect.mapError((cause) =>
      cause._tag === "NomiorReviewJobNotFoundError"
        ? // A card for a job that is gone: retrying cannot bring it back.
          new NomiorRequestError({
            message: `No review job with id ${input.jobId}.`,
            retryable: false,
          })
        : failed("Could not request a manual review.", true)(cause),
    ),
  );
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/**
 * Colour index is the account's position in driver-then-id order, so a given
 * account keeps its colour across reloads without storing one.
 */
export const toWireCalendarAccounts = (
  accounts: ReadonlyArray<{
    readonly accountId: string;
    readonly displayName: string | null;
    readonly driverKind: string;
  }>,
): ReadonlyArray<NomiorCalendarAccount> =>
  [...accounts]
    .sort(
      (left, right) =>
        left.driverKind.localeCompare(right.driverKind) ||
        left.accountId.localeCompare(right.accountId),
    )
    .map((account, index) => ({
      id: account.accountId,
      email: account.displayName ?? account.accountId,
      colorIndex: index,
    }));

export const listCalendarAccounts = Effect.fn("nomior.rpc.listCalendarAccounts")(function* (
  store: ConnectorAccountStore["Service"],
) {
  const accounts = yield* store
    .listByDriver(GOOGLE_CALENDAR_DRIVER_KIND)
    .pipe(Effect.mapError(failed("Calendar accounts are unavailable.", true)));
  return { accounts: toWireCalendarAccounts(accounts) };
});

const toWireCalendarEvent = (event: StoredCalendarEvent): NomiorCalendarEvent => ({
  id: event.id,
  accountId: event.accountId,
  title: event.title,
  start: event.start,
  end: event.end,
  recurringSeriesId: event.recurringSeriesId,
  meeting:
    event.meetingId === null
      ? null
      : {
          meetingId: event.meetingId,
          hasTranscript: event.hasTranscript,
          hasNotes: event.hasNotes,
        },
});

export const listCalendarEvents = Effect.fn("nomior.rpc.listCalendarEvents")(function* (
  store: CalendarEventStore["Service"],
  input: { readonly rangeStart: string; readonly rangeEnd: string },
) {
  const events = yield* store
    .listWindow({ rangeStart: input.rangeStart, rangeEnd: input.rangeEnd })
    .pipe(Effect.mapError(failed("Calendar events are unavailable.", true)));
  return { events: events.map(toWireCalendarEvent) };
});

// ---------------------------------------------------------------------------
// Instances & scheduler
// ---------------------------------------------------------------------------

/**
 * An instance reads as signed-out when the user has not signed in, or when its
 * driver is missing from this build (an unavailable shadow, which cannot serve
 * a turn either). `unknown` auth counts as signed in: the provider has simply
 * not been probed yet, and a red badge for a working account would be a lie.
 */
export const toPanelInput = (snapshot: ServerProvider): PanelInstanceInput => ({
  id: snapshot.instanceId,
  label: snapshot.displayName ?? snapshot.driver,
  provider: snapshot.driver,
  signedIn: isProviderAvailable(snapshot) && snapshot.auth.status !== "unauthenticated",
});

export const listInstances = Effect.fn("nomior.rpc.listInstances")(function* (
  snapshots: ReadonlyArray<ServerProvider>,
  observer: RateLimitObserverShape,
  preferences: SchedulerPreferencesShape,
) {
  const rateLimits = yield* observer.snapshot();
  const pinned = yield* preferences
    .listPinned()
    .pipe(Effect.mapError(failed("Instance pins are unavailable.", true)));
  return {
    instances: toPanelInstances({ instances: snapshots.map(toPanelInput), rateLimits, pinned }),
  };
});

export const setInstancePinned = Effect.fn("nomior.rpc.setInstancePinned")(function* (
  preferences: SchedulerPreferencesShape,
  input: { readonly instanceId: string; readonly pinned: boolean },
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* preferences
    .setPinned(input.instanceId, input.pinned, now)
    .pipe(Effect.mapError(failed("Could not change the pin.", true)));
});

export const getSchedulerState = Effect.fn("nomior.rpc.getSchedulerState")(function* (
  preferences: SchedulerPreferencesShape,
): Effect.fn.Return<NomiorSchedulerState, NomiorRequestError> {
  const advisoryMode = yield* preferences
    .advisoryMode()
    .pipe(Effect.mapError(failed("Scheduler state is unavailable.", true)));
  const lastDecision = yield* preferences
    .lastDecision()
    .pipe(Effect.mapError(failed("Scheduler state is unavailable.", true)));
  return { advisoryMode, lastDecision: Option.getOrNull(lastDecision) };
});

export const setAdvisoryMode = Effect.fn("nomior.rpc.setAdvisoryMode")(function* (
  preferences: SchedulerPreferencesShape,
  input: { readonly enabled: boolean },
) {
  yield* preferences
    .setAdvisoryMode(input.enabled)
    .pipe(Effect.mapError(failed("Could not change advisory mode.", true)));
});
