/**
 * Fixture-backed Nomior data port.
 *
 * The data is not written here: it is generated from the seed scenario
 * (`apps/server/src/nomior/seed/scenario.ts`, via `pnpm --filter t3
 * nomior:gen-fixtures`) into `./fixtures.generated`, so the panels and a
 * seeded database show the same world instead of two hand-maintained copies.
 * This module is the part that cannot be generated: resolving the scenario's
 * offsets against "now", and the session-local state the panels mutate —
 * manual-review requests, memory decisions, pins and the advisory toggle stick
 * until reload.
 *
 * Meetings and connectors are the exceptions: the seed scenario carries
 * neither, so they are hand-written in `./fixtures.meetings` and
 * `./fixtures.connectors` and resolved here the same way.
 *
 * @module nomior/fixtures
 */
import {
  GOOGLE_CLIENT_CONFIGURED,
  GOOGLE_CLIENT_UNCONFIGURED,
  connectorAccountScenarios,
} from "./fixtures.connectors";
import { generatedFixtures } from "./fixtures.generated";
import { meetingScenarios } from "./fixtures.meetings";
import { applyPin } from "./instances.logic";
import type { NomiorDataPort } from "./port";
import type {
  CalendarAccount,
  CalendarEventItem,
  ConnectorAccountItem,
  ContextSnippet,
  GoogleClientState,
  MeetingDetail,
  ProviderInstanceItem,
  ReviewJobDetail,
  SchedulerState,
  TranscriptTurn,
} from "./types";

const HOUR_MS = 3_600_000;

const hoursAgo = (now: Date, hours: number): string =>
  new Date(now.getTime() - hours * HOUR_MS).toISOString();

/** Monday 00:00 of the week containing `now`, in the viewer's own timezone. */
function weekStart(now: Date): Date {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/**
 * Every seeded job, board card and detail in one array — the same row answers
 * both reads, so a manual-review request made on a card is the one the detail
 * page shows. `listReviewJobs` filters it the way the server's query does.
 */
function reviewJobs(now: Date): ReviewJobDetail[] {
  return generatedFixtures.reviewJobs.map((job) => ({
    id: job.id,
    repo: job.repo,
    pullRequestNumber: job.pullRequestNumber,
    pullRequestTitle: job.pullRequestTitle,
    pullRequestState: job.pullRequestState,
    riskTier: job.riskTier,
    status: job.status,
    verdict: job.verdict,
    severityCounts: job.severityCounts,
    manualReviewRequested: job.manualReviewRequested,
    headSha: job.headSha,
    createdAt: hoursAgo(now, job.createdAgoHours),
    updatedAt: hoursAgo(now, job.updatedAgoHours),
  }));
}

/** Kept keyed by project: search is scope-first, so the filter is not optional. */
const contextSnippets = generatedFixtures.contextSnippets.map((snippet) => ({
  projectId: snippet.projectId,
  snippet: {
    id: snippet.id,
    sourceTitle: snippet.sourceTitle,
    sourceKind: snippet.sourceKind,
    sourceDate: snippet.sourceDate,
    excerpt: snippet.excerpt,
    score: snippet.score,
  } satisfies ContextSnippet,
}));

const calendarAccounts: readonly CalendarAccount[] = generatedFixtures.calendarAccounts.map(
  (account) => ({
    id: account.id,
    email: account.email,
    colorIndex: account.colorIndex,
  }),
);

/** The scenario's week, laid over the viewer's current week. */
function calendarEvents(now: Date): CalendarEventItem[] {
  const monday = weekStart(now);
  return generatedFixtures.calendarEvents.map((event) => {
    const start = new Date(monday);
    start.setDate(start.getDate() + event.dayOffset);
    start.setHours(event.startHour, event.startMinute, 0, 0);
    const end = new Date(start.getTime() + event.durationMinutes * 60_000);
    return {
      id: event.id,
      accountId: event.accountId,
      title: event.title,
      start: start.toISOString(),
      end: end.toISOString(),
      recurringSeriesId: event.recurringSeriesId,
      meeting: event.meeting,
    };
  });
}

/**
 * Turns a meeting scenario into the pair the port serves. `durationMs` is
 * derived from the transcript exactly as the broker derives it — first known
 * start to last known end — which leaves it null for an untimed transcript and
 * for one with no turns at all.
 */
function meetingDetail(now: Date, scenario: (typeof meetingScenarios)[number]): MeetingDetail {
  const turns: TranscriptTurn[] = scenario.turns.map((turn, index) => ({
    id: `${scenario.id}-t${index}`,
    ordinal: index,
    speaker: turn.speaker,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
  }));

  const offsets = turns.flatMap((turn) => [turn.startMs, turn.endMs].filter((ms) => ms !== null));
  const durationMs = offsets.length === 0 ? null : Math.max(...offsets) - Math.min(...offsets);

  let startedAt: string | null = null;
  if (scenario.dayOffset !== null) {
    const start = weekStart(now);
    start.setDate(start.getDate() + scenario.dayOffset);
    start.setHours(scenario.startHour, scenario.startMinute, 0, 0);
    startedAt = start.toISOString();
  }

  return {
    meeting: {
      id: scenario.id,
      title: scenario.title,
      startedAt,
      durationMs,
      participants: scenario.participants,
      turnCount: turns.length,
      hasNotes: scenario.notes !== null,
      calendarEventId: scenario.calendarEventId,
    },
    transcript: turns,
    notes: scenario.notes,
  };
}

function connectorAccounts(now: Date): ConnectorAccountItem[] {
  return connectorAccountScenarios.map((account) => ({
    id: account.id,
    kind: account.kind,
    displayName: account.displayName,
    status: account.status,
    lastSyncedAt:
      account.lastSyncedAgoHours === null ? null : hoursAgo(now, account.lastSyncedAgoHours),
    detail: account.detail,
  }));
}

function instances(): ProviderInstanceItem[] {
  return generatedFixtures.instances.map((instance) => ({
    id: instance.id,
    label: instance.label,
    provider: instance.provider,
    health: instance.health,
    pinned: instance.pinned,
    headroom: instance.headroom,
  }));
}

/** In-memory fixture implementation of the Nomior data port. */
export function createFixtureNomiorPort(now: Date = new Date()): NomiorDataPort {
  let jobs = reviewJobs(now);
  let providerInstances: readonly ProviderInstanceItem[] = instances();
  let scheduler: SchedulerState = {
    lastDecision: {
      instanceId: generatedFixtures.schedulerDecision.instanceId,
      reason: generatedFixtures.schedulerDecision.reason,
      decidedAt: hoursAgo(now, generatedFixtures.schedulerDecision.decidedAgoHours),
    },
    advisoryMode: true,
  };
  const events = calendarEvents(now);
  const meetings = new Map(
    meetingScenarios.map((scenario) => [scenario.id, meetingDetail(now, scenario)] as const),
  );
  let accounts: readonly ConnectorAccountItem[] = connectorAccounts(now);
  let google: GoogleClientState = GOOGLE_CLIENT_CONFIGURED;

  return {
    isFixture: true,

    listReviewJobs: () => Promise.resolve(jobs.filter((job) => job.pullRequestState === "open")),
    getReviewJob: (jobId) => {
      const job = jobs.find((entry) => entry.id === jobId);
      return job === undefined
        ? Promise.reject(new Error(`No review for id ${jobId}.`))
        : Promise.resolve(job);
    },
    requestManualReview: (jobId) => {
      jobs = jobs.map((job) =>
        job.id === jobId
          ? { ...job, status: "waiting-external", manualReviewRequested: true }
          : job,
      );
      return Promise.resolve();
    },

    listProjects: () => Promise.resolve(generatedFixtures.projects),
    searchContext: (query, projectId) => {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return Promise.resolve([]);
      const matches = contextSnippets
        .filter(
          (entry) =>
            entry.projectId === projectId &&
            `${entry.snippet.sourceTitle} ${entry.snippet.excerpt}`.toLowerCase().includes(needle),
        )
        .map((entry) => entry.snippet);
      return Promise.resolve(matches.toSorted((left, right) => right.score - left.score));
    },

    listCalendarAccounts: () => Promise.resolve(calendarAccounts),
    listCalendarEvents: (rangeStart, rangeEnd) =>
      Promise.resolve(events.filter((event) => event.start < rangeEnd && event.end > rangeStart)),

    listMeetings: () => Promise.resolve([...meetings.values()].map((detail) => detail.meeting)),
    getMeeting: (meetingId) => {
      const detail = meetings.get(meetingId);
      return detail === undefined
        ? Promise.reject(new Error(`No meeting ${meetingId}.`))
        : Promise.resolve(detail);
    },

    listConnectors: () =>
      Promise.resolve({
        accounts,
        google,
        // The fixture port is the browser's own sample data, so nothing about
        // it is remote; the remote copy is exercised by the panel tests.
        canStartLocalOAuth: true,
      }),
    setGoogleClientId: (clientId) => {
      const trimmed = clientId.trim();
      // Only the hint is ever kept, here as on the server: the panel has no
      // way to render a full client id because it is never handed one.
      google =
        trimmed.length === 0
          ? GOOGLE_CLIENT_UNCONFIGURED
          : { configured: true, source: "operator", clientIdHint: trimmed.slice(-4) };
      return Promise.resolve();
    },
    // Sample data has no OAuth server and no machine to read a store on.
    // Resolving a fake URL would send the user to an address that does not
    // exist, so the fixture fails the way the real port fails.
    connectConnector: () =>
      Promise.reject(
        new Error("Sample data can't connect an account. Pair an environment and try again."),
      ),
    disconnectConnector: (accountId) => {
      accounts = accounts.filter((account) => account.id !== accountId);
      return Promise.resolve();
    },
    syncConnector: (accountId) => {
      const account = accounts.find((entry) => entry.id === accountId);
      if (account === undefined) return Promise.reject(new Error(`No connector ${accountId}.`));
      if (account.status === "revoked") {
        return Promise.reject(
          new Error("Access was revoked for this account. Connect it again to restore it."),
        );
      }
      // A failed sync is the transient one, so a retry both clears the status
      // and has something to show for itself.
      const ingested = account.status === "error" ? 3 : 0;
      accounts = accounts.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              status: "connected",
              detail: null,
              lastSyncedAt: new Date().toISOString(),
            }
          : entry,
      );
      return Promise.resolve(ingested);
    },

    listInstances: () => Promise.resolve(providerInstances),
    setInstancePinned: (id, pinned) => {
      providerInstances = applyPin(providerInstances, id, pinned);
      if (pinned) {
        const target = providerInstances.find((instance) => instance.id === id);
        scheduler = {
          ...scheduler,
          lastDecision: {
            instanceId: id,
            reason: `Pinned manually${target ? ` to ${target.label}` : ""}; automatic signals ignored until unpinned.`,
            decidedAt: new Date().toISOString(),
          },
        };
      } else {
        // The pin is gone, so the "pinned manually" decision no longer holds:
        // fall back to the headroom signal, like the real scheduler would.
        const best = providerInstances
          .filter((instance) => instance.health !== "signed-out" && instance.headroom !== null)
          .toSorted((left, right) => (right.headroom ?? 0) - (left.headroom ?? 0))
          .at(0);
        scheduler = {
          ...scheduler,
          lastDecision: best
            ? {
                instanceId: best.id,
                reason: `Pin cleared; highest rate-limit headroom (${Math.round((best.headroom ?? 0) * 100)}%).`,
                decidedAt: new Date().toISOString(),
              }
            : null,
        };
      }
      return Promise.resolve();
    },
    getSchedulerState: () => Promise.resolve(scheduler),
    setAdvisoryMode: (enabled) => {
      scheduler = { ...scheduler, advisoryMode: enabled };
      return Promise.resolve();
    },
  };
}

let sharedFixturePort: NomiorDataPort | null = null;

/** Session-stable fixture port so panel navigation keeps its state. */
export function fixtureNomiorPort(): NomiorDataPort {
  sharedFixturePort ??= createFixtureNomiorPort();
  return sharedFixturePort;
}
