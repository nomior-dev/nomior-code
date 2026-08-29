/**
 * Fixture-backed Nomior data port.
 *
 * Deterministic in shape, relative in time: timestamps are derived from "now"
 * at construction so the panels always render a live-looking state without a
 * server. The port is stateful within a session — manual-review requests,
 * memory decisions, pins and the advisory toggle stick until reload.
 *
 * @module nomior/fixtures
 */
import { applyCandidateResolution } from "./contextMemory.logic";
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

const hoursAgo = (now: Date, hours: number): string =>
  new Date(now.getTime() - hours * 3_600_000).toISOString();

function fixtureReviewJobs(now: Date): ReviewJob[] {
  return [
    {
      id: "rev-101",
      repo: "nomior-dev/nomior-code",
      pullRequestNumber: 412,
      pullRequestTitle: "feat(server): context broker retrieval pipeline",
      riskTier: "high",
      status: "queue",
      verdict: null,
      severityCounts: { blocker: 0, major: 0, minor: 0 },
      manualReviewRequested: false,
      updatedAt: hoursAgo(now, 0.4),
    },
    {
      id: "rev-102",
      repo: "nomior-dev/nomior-invest",
      pullRequestNumber: 388,
      pullRequestTitle: "fix(pipeline): dedupe filings ingest cursors",
      riskTier: "medium",
      status: "queue",
      verdict: null,
      severityCounts: { blocker: 0, major: 0, minor: 0 },
      manualReviewRequested: false,
      updatedAt: hoursAgo(now, 1.2),
    },
    {
      id: "rev-103",
      repo: "nomior-dev/nomior-code",
      pullRequestNumber: 409,
      pullRequestTitle: "feat(web): instances panel scheduler surface",
      riskTier: "medium",
      status: "reviewing",
      verdict: null,
      severityCounts: { blocker: 0, major: 1, minor: 2 },
      manualReviewRequested: false,
      updatedAt: hoursAgo(now, 0.1),
    },
    {
      id: "rev-104",
      repo: "nomior-dev/nomior-music",
      pullRequestNumber: 96,
      pullRequestTitle: "feat(catalog): ISRC dedupe pass over delivery feeds",
      riskTier: "high",
      status: "waiting-external",
      verdict: null,
      severityCounts: { blocker: 1, major: 1, minor: 0 },
      manualReviewRequested: true,
      updatedAt: hoursAgo(now, 3),
    },
    {
      id: "rev-105",
      repo: "nomior-dev/nomior-code",
      pullRequestNumber: 401,
      pullRequestTitle: "chore(fork): daily upstream sync",
      riskTier: "low",
      status: "approved",
      verdict: "approved",
      severityCounts: { blocker: 0, major: 0, minor: 1 },
      manualReviewRequested: false,
      updatedAt: hoursAgo(now, 6),
    },
    {
      id: "rev-106",
      repo: "nomior-dev/nomior-invest",
      pullRequestNumber: 379,
      pullRequestTitle: "feat(agents): unattended portfolio rebalancer",
      riskTier: "high",
      status: "not-approved",
      verdict: "not-approved",
      severityCounts: { blocker: 2, major: 3, minor: 1 },
      manualReviewRequested: false,
      updatedAt: hoursAgo(now, 26),
    },
  ];
}

const FIXTURE_SNIPPETS: readonly ContextSnippet[] = [
  {
    id: "ctx-9001",
    sourceTitle: "Weekly sync — review engine scope",
    sourceKind: "meeting",
    sourceDate: "2026-08-24",
    excerpt:
      "Decision: the review board mirrors the engine state machine one-to-one — Queue, Reviewing, Waiting external, then a verdict column. Manual review is a first-class request, not a fallback.",
    score: 0.92,
  },
  {
    id: "ctx-9002",
    sourceTitle: "PLAN.md — instance scheduler",
    sourceKind: "document",
    sourceDate: "2026-08-29",
    excerpt:
      "Scheduler signals are credential-free by construction: rate-limit events arrive in the provider stream the app already parses. Manual pin > sticky-per-project > headroom > round-robin.",
    score: 0.87,
  },
  {
    id: "ctx-9003",
    sourceTitle: "Thread: capsule bootstrap flow",
    sourceKind: "thread",
    sourceDate: "2026-08-27",
    excerpt:
      "Capsule open should restore the devx stack first, then attach the session; t3.json scripts are the generic fallback when a repo has no devx profile.",
    score: 0.81,
  },
  {
    id: "ctx-9004",
    sourceTitle: "Review #388 — ingest cursors",
    sourceKind: "review",
    sourceDate: "2026-08-28",
    excerpt:
      "Finding (major): cursor table writes are not idempotent across retries; a replayed batch double-advances the incremental sync window.",
    score: 0.74,
  },
];

function fixtureMemoryCandidates(now: Date): MemoryCandidate[] {
  return [
    {
      id: "mem-501",
      text: "Ingest cursor writes must be idempotent: derive the cursor key from the batch id, never from wall-clock time.",
      source: "Review #388 — nomior-dev/nomior-invest",
      capturedAt: hoursAgo(now, 5),
      status: "pending",
    },
    {
      id: "mem-502",
      text: "The review board's Waiting external column maps to the engine's `external` status; cards there always carry a human owner.",
      source: "Weekly sync — 2026-08-24",
      capturedAt: hoursAgo(now, 20),
      status: "pending",
    },
    {
      id: "mem-503",
      text: "Scheduler explanations are user-facing copy: every automatic pick must name its signal (pin, sticky, headroom, round-robin).",
      source: "PLAN.md — instance scheduler",
      capturedAt: hoursAgo(now, 44),
      status: "pending",
    },
  ];
}

const FIXTURE_ACCOUNTS: readonly CalendarAccount[] = [
  { id: "acct-work", email: "work@nomior.example", colorIndex: 0 },
  { id: "acct-personal", email: "personal@gmail.example", colorIndex: 1 },
  { id: "acct-studio", email: "studio@nomior.example", colorIndex: 2 },
];

/** Events laid out relative to the current week so the panel never looks stale. */
function fixtureCalendarEvents(now: Date): CalendarEventItem[] {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  const weekday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - weekday);
  const at = (day: number, hour: number, minutes = 0): string => {
    const date = new Date(monday);
    date.setDate(date.getDate() + day);
    date.setHours(hour, minutes, 0, 0);
    return date.toISOString();
  };
  return [
    {
      id: "evt-1",
      accountId: "acct-work",
      title: "Daily standup",
      start: at(0, 9, 30),
      end: at(0, 9, 45),
      recurringSeriesId: "series-standup",
      meeting: { meetingId: "meet-11", hasTranscript: true, hasNotes: true },
    },
    {
      id: "evt-2",
      accountId: "acct-work",
      title: "Daily standup",
      start: at(1, 9, 30),
      end: at(1, 9, 45),
      recurringSeriesId: "series-standup",
      meeting: { meetingId: "meet-12", hasTranscript: true, hasNotes: false },
    },
    {
      id: "evt-3",
      accountId: "acct-work",
      title: "Daily standup",
      start: at(2, 9, 30),
      end: at(2, 9, 45),
      recurringSeriesId: "series-standup",
      meeting: null,
    },
    {
      id: "evt-4",
      accountId: "acct-work",
      title: "Review engine deep dive",
      start: at(1, 14, 0),
      end: at(1, 15, 30),
      recurringSeriesId: null,
      meeting: { meetingId: "meet-14", hasTranscript: true, hasNotes: true },
    },
    {
      id: "evt-5",
      accountId: "acct-studio",
      title: "Label data licensing call",
      start: at(2, 16, 0),
      end: at(2, 17, 0),
      recurringSeriesId: null,
      meeting: { meetingId: "meet-15", hasTranscript: false, hasNotes: true },
    },
    {
      id: "evt-6",
      accountId: "acct-personal",
      title: "Dentist",
      start: at(3, 11, 0),
      end: at(3, 12, 0),
      recurringSeriesId: null,
      meeting: null,
    },
    {
      id: "evt-7",
      accountId: "acct-work",
      title: "Weekly sync",
      start: at(4, 13, 0),
      end: at(4, 14, 0),
      recurringSeriesId: "series-weekly",
      meeting: null,
    },
    {
      id: "evt-8",
      accountId: "acct-studio",
      title: "Mix review — EP master",
      start: at(4, 17, 0),
      end: at(4, 18, 30),
      recurringSeriesId: null,
      meeting: null,
    },
  ];
}

function fixtureInstances(): ProviderInstanceItem[] {
  return [
    {
      id: "inst-claude-main",
      label: "Claude — main",
      provider: "Claude",
      health: "healthy",
      pinned: false,
      headroom: 0.72,
    },
    {
      id: "inst-claude-alt",
      label: "Claude — studio",
      provider: "Claude",
      health: "throttled",
      pinned: false,
      headroom: 0.06,
    },
    {
      id: "inst-codex-main",
      label: "Codex — main",
      provider: "Codex",
      health: "healthy",
      pinned: false,
      headroom: 0.55,
    },
    {
      id: "inst-grok",
      label: "Grok",
      provider: "Grok",
      health: "signed-out",
      pinned: false,
      headroom: null,
    },
  ];
}

/** In-memory fixture implementation of the Nomior data port. */
export function createFixtureNomiorPort(now: Date = new Date()): NomiorDataPort {
  let reviewJobs = fixtureReviewJobs(now);
  let memoryCandidates: readonly MemoryCandidate[] = fixtureMemoryCandidates(now);
  let instances: readonly ProviderInstanceItem[] = fixtureInstances();
  let scheduler: SchedulerState = {
    lastDecision: {
      instanceId: "inst-claude-main",
      reason: "Highest rate-limit headroom (72%); Claude — studio is throttled until 18:00.",
      decidedAt: hoursAgo(now, 0.2),
    },
    advisoryMode: true,
  };
  const calendarEvents = fixtureCalendarEvents(now);

  return {
    isFixture: true,

    listReviewJobs: () => Promise.resolve(reviewJobs),
    requestManualReview: (jobId) => {
      reviewJobs = reviewJobs.map((job) =>
        job.id === jobId
          ? { ...job, status: "waiting-external", manualReviewRequested: true }
          : job,
      );
      return Promise.resolve();
    },

    searchContext: (query) => {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return Promise.resolve([]);
      const matches = FIXTURE_SNIPPETS.filter((snippet) =>
        `${snippet.sourceTitle} ${snippet.excerpt}`.toLowerCase().includes(needle),
      );
      return Promise.resolve(matches.toSorted((left, right) => right.score - left.score));
    },
    // The fixture has no real sources to open; the RPC port navigates.
    openContextSource: () => Promise.resolve(),
    listMemoryCandidates: () => Promise.resolve(memoryCandidates),
    resolveMemoryCandidate: (id, resolution) => {
      memoryCandidates = applyCandidateResolution(memoryCandidates, id, resolution);
      return Promise.resolve();
    },

    listCalendarAccounts: () => Promise.resolve(FIXTURE_ACCOUNTS),
    listCalendarEvents: (rangeStart, rangeEnd) =>
      Promise.resolve(
        calendarEvents.filter((event) => event.start < rangeEnd && event.end > rangeStart),
      ),

    listInstances: () => Promise.resolve(instances),
    setInstancePinned: (id, pinned) => {
      instances = applyPin(instances, id, pinned);
      if (pinned) {
        const target = instances.find((instance) => instance.id === id);
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
        const best = instances
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
