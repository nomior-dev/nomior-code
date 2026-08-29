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
 * @module nomior/fixtures
 */
import { applyCandidateResolution } from "./contextMemory.logic";
import { generatedFixtures } from "./fixtures.generated";
import { applyPin } from "./instances.logic";
import type { NomiorDataPort } from "./port";
import type {
  CalendarAccount,
  CalendarEventItem,
  ContextSnippet,
  MemoryCandidate,
  ProviderInstanceItem,
  ReviewJob,
  SchedulerState,
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

function reviewJobs(now: Date): ReviewJob[] {
  return generatedFixtures.reviewJobs.map((job) => ({
    id: job.id,
    repo: job.repo,
    pullRequestNumber: job.pullRequestNumber,
    pullRequestTitle: job.pullRequestTitle,
    riskTier: job.riskTier,
    status: job.status,
    verdict: job.verdict,
    severityCounts: job.severityCounts,
    manualReviewRequested: job.manualReviewRequested,
    updatedAt: hoursAgo(now, job.updatedAgoHours),
  }));
}

const contextSnippets: readonly ContextSnippet[] = generatedFixtures.contextSnippets.map(
  (snippet) => ({
    id: snippet.id,
    sourceTitle: snippet.sourceTitle,
    sourceKind: snippet.sourceKind,
    sourceDate: snippet.sourceDate,
    excerpt: snippet.excerpt,
    score: snippet.score,
  }),
);

function memoryCandidates(now: Date): MemoryCandidate[] {
  return generatedFixtures.memoryCandidates.map((candidate) => ({
    id: candidate.id,
    text: candidate.text,
    source: candidate.source,
    capturedAt: hoursAgo(now, candidate.capturedAgoHours),
    // Generated candidates are always pending: the seed cannot fabricate an
    // approved memory, because approval is the user's to give.
    status: "pending",
  }));
}

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
  let candidates: readonly MemoryCandidate[] = memoryCandidates(now);
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

  return {
    isFixture: true,

    listReviewJobs: () => Promise.resolve(jobs),
    requestManualReview: (jobId) => {
      jobs = jobs.map((job) =>
        job.id === jobId
          ? { ...job, status: "waiting-external", manualReviewRequested: true }
          : job,
      );
      return Promise.resolve();
    },

    searchContext: (query) => {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return Promise.resolve([]);
      const matches = contextSnippets.filter((snippet) =>
        `${snippet.sourceTitle} ${snippet.excerpt}`.toLowerCase().includes(needle),
      );
      return Promise.resolve(matches.toSorted((left, right) => right.score - left.score));
    },
    // The fixture has no real sources to open; the RPC port navigates.
    openContextSource: () => Promise.resolve(),
    listMemoryCandidates: () => Promise.resolve(candidates),
    resolveMemoryCandidate: (id, resolution) => {
      candidates = applyCandidateResolution(candidates, id, resolution);
      return Promise.resolve();
    },

    listCalendarAccounts: () => Promise.resolve(calendarAccounts),
    listCalendarEvents: (rangeStart, rangeEnd) =>
      Promise.resolve(events.filter((event) => event.start < rangeEnd && event.end > rangeStart)),

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
