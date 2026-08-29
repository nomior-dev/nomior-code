// @effect-diagnostics nodeBuiltinImport:off - build-time codegen, not runtime.
/**
 * webFixtures - derive the web panels' fixture data from the seed scenario.
 *
 * The panels must keep rendering standalone, with no server and no database,
 * so they cannot import the scenario at runtime. They get a generated module
 * instead (`apps/web/src/nomior/fixtures.generated.ts`), produced from exactly
 * the data the seeder writes — one source of truth, two consumers.
 *
 * Time is emitted as offsets, not instants: the scenario is dated
 * (Mon 2026-08-24 … Sat 2026-08-29) but the panels must look alive whenever
 * they are opened, so events carry a day offset into the current week and
 * timestamps carry hours-before-now. The content — titles, series, speakers,
 * findings, reasons — is the scenario's, verbatim.
 *
 * @module nomior/seed/webFixtures
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  SEED_NOW,
  SEED_WEEK_START,
  seedCalendarEvents,
  seedGoogleAccounts,
  seedMeetings,
  seedProviderInstances,
  seedReviewJobs,
  type SeedFindingSeverity,
  type SeedMeeting,
} from "./scenario.ts";
import { candidateMemories } from "./sourceInputs.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const hoursBeforeNow = (iso: string): number =>
  round2((Date.parse(SEED_NOW) - Date.parse(iso)) / HOUR_MS);

/**
 * Hour and minute of an ISO-8601 UTC instant, read out of the string itself.
 * Generation must never depend on the machine's timezone, and every instant
 * in the scenario is written with a `Z`.
 */
const utcTimeOf = (iso: string): { readonly hour: number; readonly minute: number } => {
  const match = /T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?Z$/.exec(iso);
  if (match === null) {
    throw new Error(`webFixtures: '${iso}' is not a UTC ISO-8601 instant`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
};

// ---------------------------------------------------------------------------
// Review board
// ---------------------------------------------------------------------------

/**
 * Every seeded job, settled pull requests included: the fixture port filters
 * the board's list the way the server's query does, and its detail read has to
 * answer for a job the board has already dropped.
 */
export interface GeneratedReviewJob {
  readonly id: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly pullRequestState: "open" | "merged" | "closed";
  readonly riskTier: "low" | "medium" | "high";
  readonly status: "queue" | "reviewing" | "waiting-external" | "approved" | "not-approved";
  readonly verdict: "approved" | "not-approved" | null;
  readonly severityCounts: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
  };
  readonly manualReviewRequested: boolean;
  readonly headSha: string;
  readonly createdAgoHours: number;
  readonly updatedAgoHours: number;
}

/**
 * Board severity buckets from engine severities. `critical` blocks a merge on
 * its own, `high` blocks too but is the reviewable kind, `medium`/`low` are
 * follow-ups; `info` is not a finding the board counts.
 */
export const severityCounts = (
  severities: ReadonlyArray<SeedFindingSeverity>,
): GeneratedReviewJob["severityCounts"] => ({
  blocker: severities.filter((severity) => severity === "critical").length,
  major: severities.filter((severity) => severity === "high").length,
  minor: severities.filter((severity) => severity === "medium" || severity === "low").length,
});

export const generatedReviewJobs = (): ReadonlyArray<GeneratedReviewJob> =>
  seedReviewJobs.map((job) => ({
    id: job.jobId,
    repo: job.repo,
    pullRequestNumber: job.pullRequestNumber,
    pullRequestTitle: job.pullRequestTitle,
    pullRequestState: job.pullRequestState,
    riskTier: job.riskTier,
    // The board has one column per engine state; only `queued` is spelled
    // differently, because a column is a place and a status is a state.
    status: job.status === "queued" ? "queue" : job.status,
    verdict:
      job.verdict === null ? null : job.verdict === "not-approved" ? "not-approved" : "approved",
    severityCounts: severityCounts(job.findings.map((finding) => finding.severity)),
    manualReviewRequested: job.manualReviewRequested,
    headSha: job.headSha,
    createdAgoHours: hoursBeforeNow(job.createdAt),
    updatedAgoHours: hoursBeforeNow(job.updatedAt),
  }));

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface GeneratedCalendarAccount {
  readonly id: string;
  readonly email: string;
  readonly colorIndex: number;
}

export interface GeneratedCalendarEvent {
  readonly id: string;
  readonly accountId: string;
  readonly title: string;
  /** Days from the scenario week's Monday; negative means a previous week. */
  readonly dayOffset: number;
  readonly startHour: number;
  readonly startMinute: number;
  readonly durationMinutes: number;
  readonly recurringSeriesId: string | null;
  readonly meeting: {
    readonly meetingId: string;
    readonly hasTranscript: boolean;
    readonly hasNotes: boolean;
  } | null;
}

export const generatedCalendarAccounts = (): ReadonlyArray<GeneratedCalendarAccount> =>
  seedGoogleAccounts.map((account) => ({
    id: account.accountId,
    email: account.email,
    colorIndex: account.colorIndex,
  }));

export const generatedCalendarEvents = (): ReadonlyArray<GeneratedCalendarEvent> => {
  const weekStart = Date.parse(SEED_WEEK_START);
  const meetingsById = new Map<string, SeedMeeting>(
    seedMeetings.map((meeting) => [meeting.meetingId, meeting]),
  );
  return seedCalendarEvents.map((event) => {
    const start = utcTimeOf(event.startsAt);
    const meeting = event.meetingId === null ? null : meetingsById.get(event.meetingId);
    return {
      id: event.eventId,
      accountId: event.accountId,
      title: event.title,
      // UTC throughout: generation must not depend on the machine's zone.
      dayOffset: Math.floor((Date.parse(event.startsAt) - weekStart) / DAY_MS),
      startHour: start.hour,
      startMinute: start.minute,
      durationMinutes: Math.round((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000),
      recurringSeriesId: event.recurringSeriesId,
      meeting:
        meeting === undefined || meeting === null
          ? null
          : {
              meetingId: meeting.meetingId,
              hasTranscript: meeting.transcript.length > 0,
              hasNotes: meeting.notes.length > 0,
            },
    };
  });
};

// ---------------------------------------------------------------------------
// Context & memory
// ---------------------------------------------------------------------------

export interface GeneratedContextSnippet {
  readonly id: string;
  readonly sourceTitle: string;
  readonly sourceKind: "meeting" | "decision" | "memory" | "document" | "mail" | "event";
  readonly sourceDate: string;
  readonly excerpt: string;
  readonly score: number;
}

export interface GeneratedMemoryCandidate {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly capturedAgoHours: number;
}

/**
 * Search results the panel can show without a broker: one snippet per seeded
 * decision, plus the blocking findings of the reviews that carry them. Scores
 * descend by rank — the fixture ranks, it does not measure.
 */
export const generatedContextSnippets = (): ReadonlyArray<GeneratedContextSnippet> => {
  const fromMeetings = seedMeetings.flatMap((meeting) =>
    meeting.decisions.map((decision, index) => ({
      id: `ctx-${meeting.meetingId}-d${index}`,
      sourceTitle: meeting.title,
      sourceKind: "meeting" as const,
      sourceDate: meeting.startsAt.slice(0, 10),
      excerpt: `Decision: ${decision.statement}`,
    })),
  );
  const fromReviews = seedReviewJobs.flatMap((job) =>
    job.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding, index) => ({
        id: `ctx-${job.jobId}-f${index}`,
        sourceTitle: `Review #${job.pullRequestNumber} — ${job.pullRequestTitle}`,
        sourceKind: "memory" as const,
        sourceDate: job.updatedAt.slice(0, 10),
        excerpt: `Finding (${finding.severity}): ${finding.summary} — ${finding.file}:${finding.line}`,
      })),
  );
  return [...fromMeetings, ...fromReviews].map((snippet, index) => ({
    ...snippet,
    score: round2(Math.max(0.4, 0.95 - index * 0.04)),
  }));
};

export const generatedMemoryCandidates = (): ReadonlyArray<GeneratedMemoryCandidate> =>
  candidateMemories.map((memory) => ({
    id: memory.memoryId,
    text: memory.text,
    source: memory.sourceLabel,
    capturedAgoHours: hoursBeforeNow(memory.capturedAt),
  }));

// ---------------------------------------------------------------------------
// Instances & scheduler
// ---------------------------------------------------------------------------

export interface GeneratedInstance {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly health: "healthy" | "throttled" | "signed-out";
  readonly pinned: boolean;
  readonly headroom: number | null;
}

export interface GeneratedSchedulerDecision {
  readonly instanceId: string;
  readonly reason: string;
  readonly decidedAgoHours: number;
}

export const generatedInstances = (): ReadonlyArray<GeneratedInstance> =>
  seedProviderInstances.map((instance) => ({
    id: instance.instanceId,
    label: instance.label,
    provider: instance.provider,
    health: instance.health,
    pinned: false,
    headroom: instance.usedPercent === null ? null : round2((100 - instance.usedPercent) / 100),
  }));

const throttledInstance = seedProviderInstances.find((instance) => instance.health === "throttled");

/**
 * The decision the seeded rate-limit state implies, phrased the way the
 * scheduler phrases it: the winning signal, then the number behind it.
 */
export const generatedSchedulerDecision = (): GeneratedSchedulerDecision => {
  const healthy = seedProviderInstances
    .filter((instance) => instance.health === "healthy" && instance.usedPercent !== null)
    .toSorted((left, right) => (left.usedPercent ?? 100) - (right.usedPercent ?? 100));
  const best = healthy[0];
  const headroom = best === undefined ? 0 : 100 - (best.usedPercent ?? 100);
  const resetHour =
    throttledInstance?.resetsAt === undefined || throttledInstance.resetsAt === null
      ? null
      : utcTimeOf(throttledInstance.resetsAt).hour;
  return {
    instanceId: best?.instanceId ?? "",
    reason:
      throttledInstance === undefined || resetHour === null
        ? `Picked ${best?.label ?? "the only instance"}: most rate-limit headroom (${headroom}%).`
        : `Picked ${best?.label ?? "the only instance"}: most rate-limit headroom (${headroom}%); ${throttledInstance.label} is throttled until ${String(resetHour).padStart(2, "0")}:00.`,
    decidedAgoHours: hoursBeforeNow(best?.observedAt ?? SEED_NOW),
  };
};

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Minimal TS-literal writer: unquoted keys where legal, stable key order. */
export const toTsLiteral = (value: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((item) => `${padInner}${toTsLiteral(item, indent + 1)},`);
    return `[\n${items.join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    const items = entries.map(
      ([key, item]) =>
        `${padInner}${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${toTsLiteral(item, indent + 1)},`,
    );
    return `{\n${items.join("\n")}\n${pad}}`;
  }
  throw new Error(`toTsLiteral: unsupported value ${String(value)}`);
};

const BANNER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: \`apps/server/src/nomior/seed/scenario.ts\` (the same data
 * \`pnpm nomior:seed\` writes into the database).
 * Regenerate with: \`pnpm --filter t3 nomior:gen-fixtures\`.
 *
 * Times are offsets, not instants: the scenario is dated, but the panels must
 * look alive whenever they are opened. \`fixtures.ts\` resolves them against
 * the current week.
 *
 * No imports on purpose: this module is plain data, so the panels can render
 * from it with nothing behind them and any tool can read it.
 */`;

/** The whole generated payload, before serialization. */
export const webFixtureData = () => ({
  reviewJobs: generatedReviewJobs(),
  calendarAccounts: generatedCalendarAccounts(),
  calendarEvents: generatedCalendarEvents(),
  contextSnippets: generatedContextSnippets(),
  memoryCandidates: generatedMemoryCandidates(),
  instances: generatedInstances(),
  schedulerDecision: generatedSchedulerDecision(),
});

/** The whole generated module, as text. Deterministic for a given scenario. */
export const renderWebFixturesModule = (): string =>
  [
    BANNER,
    "",
    // `as const` keeps the literal types, so `fixtures.ts` can map this into
    // the panel domain types without a cast.
    `export const generatedFixtures = ${toTsLiteral(webFixtureData())} as const;`,
    "",
  ].join("\n");

/**
 * Absolute path of the generated module, resolved from this file. Lives here
 * rather than in the CLI so the drift test can read it without importing a
 * script that writes on import.
 */
export const webFixturesPath = (): string =>
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "web",
    "src",
    "nomior",
    "fixtures.generated.ts",
  );
