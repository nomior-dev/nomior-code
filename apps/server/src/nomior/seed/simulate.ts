/**
 * simulate - drive the seeded system and prove its invariants hold.
 *
 * Five sections, in the order a demo would walk them:
 *   1. retrieval evals (own in-memory corpus, the existing golden set);
 *   2. real context queries over the seeded capsules, with citations and
 *      token counts;
 *   3. two review jobs through the whole state machine with fake legs, added
 *      to and then removed from the board so the seeded one survives the run;
 *   4. the scheduler under simulated rate-limit events, with its reasons;
 *   5. meeting assembly, joining seeded transcripts to seeded calendar events.
 *
 * The invariant checks are pure functions over observations, exported
 * separately from the program that gathers them, so the thing that decides
 * "this is a violation" is unit-testable without a database. Any violation
 * makes `pnpm nomior:simulate` exit non-zero.
 *
 * @module nomior/seed/simulate
 */
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { assembleMeetings, type AssembledMeeting } from "../connectors/matching/MeetingAssembly.ts";
import { ContextBrokerLive } from "../context/ContextBroker.ts";
import {
  formatEvalTable,
  RECALL_GATES,
  RECALL_KS,
  runRetrievalEval,
} from "../context/evals/RetrievalEval.ts";
import type { NomiorScope } from "../context/Model.ts";
import { ContextRetrieval } from "../context/Retrieval.ts";
import { MemoryCandidateStore } from "../memory/MemoryCandidateStore.ts";
import { LegRunner, type ReviewLegConfig } from "../review/Legs.ts";
import type { PlaybookPresence } from "../review/Playbook.ts";
import * as ReviewEngine from "../review/ReviewEngine.ts";
import * as ReviewJobStore from "../review/ReviewJobStore.ts";
import { ReviewPublisher } from "../review/ReviewPublisher.ts";
import type { GateDecision, ReviewJobStatus } from "../review/Schemas.ts";
import * as InstanceScheduler from "../scheduler/InstanceScheduler.ts";
import * as RateLimitObserver from "../scheduler/RateLimitObserver.ts";
import { instanceHeadroom, type SchedulerDecision } from "../scheduler/Schemas.ts";
import { seedCalendarSources, seedTranscriptSources } from "./connectorSources.ts";
import { rateLimitEvent } from "./rateLimitEvents.ts";
import {
  SCOPE_LEAK_PROBES,
  SEED_WEEK_START,
  seedContextProbes,
  seedMeetings,
  type SeedFindingSeverity,
} from "./scenario.ts";
import { candidateMemories, capsuleScope } from "./sourceInputs.ts";

// ===============================
// Invariant checks (pure)
// ===============================

export interface Violation {
  readonly kind:
    | "budget-exceeded"
    | "scope-leak"
    | "gate-approved-with-blocking-finding"
    | "unapproved-candidate-retrieved"
    | "scheduler-picked-exhausted-instance"
    | "recall-gate-missed"
    | "meeting-unlinked";
  readonly detail: string;
}

export interface BudgetObservation {
  readonly probeId: string;
  readonly budgetTokens: number;
  readonly usedTokens: number;
}

/** The hard cap: a query may never spend more than it was given. */
export const checkBudget = (
  observations: ReadonlyArray<BudgetObservation>,
): ReadonlyArray<Violation> =>
  observations.flatMap((observation) =>
    observation.usedTokens > observation.budgetTokens
      ? [
          {
            kind: "budget-exceeded" as const,
            detail: `${observation.probeId}: used ${observation.usedTokens} tokens against a ${observation.budgetTokens}-token budget`,
          },
        ]
      : [],
  );

export interface ScopeObservation {
  readonly probeId: string;
  readonly scope: NomiorScope;
  /** Every source the answer cited, with the scopes that source is bound to. */
  readonly citedSources: ReadonlyArray<{
    readonly sourceId: string;
    readonly title: string;
    readonly scopes: ReadonlyArray<NomiorScope>;
  }>;
}

/** Scope-first: a cited source must be bound to the scope that was queried. */
export const checkScopeIsolation = (
  observations: ReadonlyArray<ScopeObservation>,
): ReadonlyArray<Violation> =>
  observations.flatMap((observation) =>
    observation.citedSources
      .filter(
        (source) =>
          !source.scopes.some(
            (scope) =>
              scope.kind === observation.scope.kind && scope.value === observation.scope.value,
          ),
      )
      .map((source) => ({
        kind: "scope-leak" as const,
        detail: `${observation.probeId}: query in ${observation.scope.kind}:${observation.scope.value} cited "${source.title}" (${source.sourceId}), which is not in that scope`,
      })),
  );

export interface GateObservation {
  readonly jobId: string;
  readonly severities: ReadonlyArray<SeedFindingSeverity>;
  readonly decision: GateDecision;
}

const BLOCKING_SEVERITIES: ReadonlySet<SeedFindingSeverity> = new Set(["critical", "high"]);

/** The gate may never approve a change that carries a critical or high finding. */
export const checkGateDecision = (
  observations: ReadonlyArray<GateObservation>,
): ReadonlyArray<Violation> =>
  observations.flatMap((observation) => {
    const blocking = observation.severities.filter((severity) => BLOCKING_SEVERITIES.has(severity));
    return blocking.length > 0 && observation.decision !== "not-approved"
      ? [
          {
            kind: "gate-approved-with-blocking-finding" as const,
            detail: `${observation.jobId}: gate decided '${observation.decision}' with ${blocking.length} ${blocking.join("/")} finding(s)`,
          },
        ]
      : [];
  });

export interface CandidateObservation {
  /** Text of every memory candidate still awaiting a decision. */
  readonly pendingTexts: ReadonlyArray<string>;
  /** Text of every snippet any query in this run returned. */
  readonly retrievedTexts: ReadonlyArray<string>;
}

/** Nothing promotes without approval: a pending candidate is not retrievable. */
export const checkCandidatePromotion = (
  observation: CandidateObservation,
): ReadonlyArray<Violation> =>
  observation.pendingTexts.flatMap((pending) =>
    observation.retrievedTexts.some((retrieved) => retrieved.includes(pending))
      ? [
          {
            kind: "unapproved-candidate-retrieved" as const,
            detail: `a pending memory candidate is already retrievable: "${pending.slice(0, 72)}…"`,
          },
        ]
      : [],
  );

export interface SchedulerObservation {
  readonly step: string;
  readonly decision: SchedulerDecision;
  readonly headroomByInstance: Readonly<Record<string, number>>;
}

/**
 * The scheduler may land on an exhausted instance only when every candidate
 * is exhausted — otherwise it just sent work at a wall.
 */
export const checkSchedulerDecision = (
  observations: ReadonlyArray<SchedulerObservation>,
): ReadonlyArray<Violation> =>
  observations.flatMap((observation) => {
    if (observation.decision.kind !== "choice") {
      return [];
    }
    const chosen = observation.headroomByInstance[observation.decision.instanceId] ?? 100;
    const best = Math.max(...Object.values(observation.headroomByInstance), 0);
    return chosen === 0 && best > 0
      ? [
          {
            kind: "scheduler-picked-exhausted-instance" as const,
            detail: `${observation.step}: picked ${observation.decision.instanceId} at 0% headroom while another candidate had ${best}%`,
          },
        ]
      : [];
  });

// ===============================
// Report shapes
// ===============================

export interface QueryLine {
  readonly probeId: string;
  readonly question: string;
  readonly scope: string;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly truncated: boolean;
  readonly citations: ReadonlyArray<string>;
  readonly expectedSourceCited: boolean;
}

export interface ReviewRunLine {
  readonly jobId: string;
  readonly headSha: string;
  readonly transitions: ReadonlyArray<ReviewJobStatus>;
  readonly decision: GateDecision | "none";
  readonly reasons: ReadonlyArray<string>;
  readonly followups: number;
  readonly published: string;
  readonly severities: ReadonlyArray<SeedFindingSeverity>;
}

export interface SchedulerLine {
  readonly step: string;
  readonly event: string;
  readonly instanceId: string;
  readonly rule: string;
  readonly reason: string;
}

export interface SimulationReport {
  readonly evalTable: string;
  readonly macroRecall: Readonly<Record<number, number>>;
  readonly queries: ReadonlyArray<QueryLine>;
  readonly reviews: ReadonlyArray<ReviewRunLine>;
  readonly schedulerSteps: ReadonlyArray<SchedulerLine>;
  readonly meetings: {
    readonly total: number;
    readonly linked: number;
    readonly needConfirmation: number;
  };
  readonly newMemoryCandidates: number;
  readonly violations: ReadonlyArray<Violation>;
}

// ===============================
// Section 1 — retrieval evals
// ===============================

/**
 * The golden set runs against its own in-memory corpus, never the seeded
 * database: the eval fixtures are a measuring stick, not demo data, and they
 * have no business being visible in a capsule.
 */
const runEvalSection = Effect.gen(function* () {
  const summary = yield* runRetrievalEval;
  const violations = RECALL_KS.filter((k) => summary.macroRecall[k] < RECALL_GATES[k]).map((k) => ({
    kind: "recall-gate-missed" as const,
    detail: `macro recall@${k} = ${summary.macroRecall[k].toFixed(2)} < ${RECALL_GATES[k]}`,
  }));
  return { table: formatEvalTable(summary), macroRecall: summary.macroRecall, violations };
}).pipe(Effect.provide(ContextBrokerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))));

// ===============================
// Section 2 — context queries
// ===============================

interface ScopeRow {
  readonly sourceId: string;
  readonly scopeKind: NomiorScope["kind"];
  readonly scopeValue: string;
}

const scopesForSources = Effect.fn("simulate.scopesForSources")(function* (
  sourceIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (sourceIds.length === 0) {
    return new Map<string, Array<NomiorScope>>();
  }
  const rows = yield* sql<ScopeRow>`
    SELECT source_id AS "sourceId", scope_kind AS "scopeKind", scope_value AS "scopeValue"
    FROM nomior_source_scopes
    WHERE ${sql.in("source_id", sourceIds)}
  `;
  const byId = new Map<string, Array<NomiorScope>>();
  for (const row of rows) {
    const scopes = byId.get(row.sourceId) ?? [];
    scopes.push({ kind: row.scopeKind, value: row.scopeValue });
    byId.set(row.sourceId, scopes);
  }
  return byId;
});

const externalIdsOf = Effect.fn("simulate.externalIdsOf")(function* (
  sourceIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (sourceIds.length === 0) {
    return new Map<string, string>();
  }
  const rows = yield* sql<{ readonly id: string; readonly externalId: string | null }>`
    SELECT id, external_id AS "externalId" FROM nomior_sources WHERE ${sql.in("id", sourceIds)}
  `;
  return new Map(rows.map((row) => [row.id, row.externalId ?? row.id]));
});

const runQuerySection = Effect.gen(function* () {
  const retrieval = yield* ContextRetrieval;
  const queries: Array<QueryLine> = [];
  const budgetObservations: Array<BudgetObservation> = [];
  const scopeObservations: Array<ScopeObservation> = [];
  const retrievedTexts: Array<string> = [];

  const observe = Effect.fn("simulate.observeQuery")(function* (input: {
    readonly probeId: string;
    readonly question: string;
    readonly scope: NomiorScope;
    readonly budgetTokens: number;
    readonly expectAnyOf: ReadonlyArray<string>;
  }) {
    const result = yield* retrieval.search({
      query: input.question,
      scope: input.scope,
      budgetTokens: input.budgetTokens,
    });
    const sourceIds = [...new Set(result.snippets.map((snippet) => snippet.sourceId))];
    const scopesById = yield* scopesForSources(sourceIds);
    const externalById = yield* externalIdsOf(sourceIds);

    for (const snippet of result.snippets) {
      retrievedTexts.push(snippet.text);
    }
    budgetObservations.push({
      probeId: input.probeId,
      budgetTokens: result.budgetTokens,
      usedTokens: result.usedTokens,
    });
    scopeObservations.push({
      probeId: input.probeId,
      scope: input.scope,
      citedSources: sourceIds.map((sourceId) => ({
        sourceId,
        title: result.snippets.find((snippet) => snippet.sourceId === sourceId)?.title ?? sourceId,
        scopes: scopesById.get(sourceId) ?? [],
      })),
    });

    const externalIds = new Set(
      sourceIds.map((sourceId) => externalById.get(sourceId) ?? sourceId),
    );
    queries.push({
      probeId: input.probeId,
      question: input.question,
      scope: `${input.scope.kind}:${input.scope.value}`,
      budgetTokens: result.budgetTokens,
      usedTokens: result.usedTokens,
      truncated: result.truncated,
      citations: result.snippets.slice(0, 3).map((snippet) => snippet.citation),
      expectedSourceCited:
        input.expectAnyOf.length === 0 ||
        input.expectAnyOf.some((expected) => externalIds.has(`nomior-seed:${expected}`)),
    });
  });

  for (const probe of seedContextProbes) {
    yield* observe({
      probeId: probe.id,
      question: probe.question,
      scope: capsuleScope(probe.capsule),
      budgetTokens: probe.budgetTokens,
      expectAnyOf: probe.expectAnyOf,
    });
  }
  // Deliberate cross-capsule probes: terms that exist only in the other
  // capsule must return nothing from it.
  for (const probe of SCOPE_LEAK_PROBES) {
    yield* observe({
      probeId: probe.id,
      question: probe.query,
      scope: capsuleScope(probe.capsule),
      budgetTokens: 600,
      expectAnyOf: [],
    });
  }

  return {
    queries,
    retrievedTexts,
    violations: [...checkBudget(budgetObservations), ...checkScopeIsolation(scopeObservations)],
  };
});

// ===============================
// Section 3 — review state machine
// ===============================

const SIM_PLAYBOOK: PlaybookPresence = {
  kind: "present",
  playbook: {
    verify: "pnpm --filter t3 test, then pnpm typecheck.",
    context: "Nomior Code: a private fork of t3code. Our code is additive under nomior paths.",
    bar: "No critical or high findings, and at least one piece of runtime evidence.",
  },
};

const SIM_LEGS: ReadonlyArray<ReviewLegConfig> = [
  {
    role: "claude-verify",
    instanceId: ProviderInstanceId.make("inst-claude-main"),
    model: "opus-5",
    attachedTools: ["shell"],
  },
  {
    role: "codex-read",
    instanceId: ProviderInstanceId.make("inst-codex-main"),
    model: "gpt-5.6",
    attachedTools: [],
  },
];

interface SimulatedReview {
  readonly label: string;
  readonly headSha: string;
  readonly pullRequestNumber: number;
  readonly severities: ReadonlyArray<SeedFindingSeverity>;
  readonly legOutput: (role: string) => string;
}

const cleanLegOutput = JSON.stringify({
  findings: [
    {
      severity: "medium",
      summary: "The seed summary counts rows but not the FTS index; add it when the index grows.",
      file: "apps/server/src/nomior/seed/seed.ts",
      line: 210,
    },
  ],
  runtimeEvidence: [{ kind: "tests-run", detail: "vitest 12 passed in nomior/seed" }],
  needsExternalReview: false,
});

const criticalLegOutput = JSON.stringify({
  findings: [
    {
      severity: "critical",
      summary: "--reset deletes every context source, not only the seed's own rows.",
      file: "apps/server/src/nomior/seed/seed.ts",
      line: 108,
    },
    {
      severity: "low",
      summary: "The reset path logs nothing about how many rows it removed.",
      file: "apps/server/src/nomior/seed/seed.ts",
      line: 120,
    },
  ],
  runtimeEvidence: [{ kind: "tests-run", detail: "vitest 12 passed, 1 failed in nomior/seed" }],
  needsExternalReview: false,
});

const SIMULATED_REVIEWS: ReadonlyArray<SimulatedReview> = [
  {
    label: "clean run with a follow-up",
    headSha: "sim-clean-0001",
    pullRequestNumber: 415,
    severities: ["medium"],
    legOutput: () => cleanLegOutput,
  },
  {
    label: "critical finding must block",
    headSha: "sim-critical-0002",
    pullRequestNumber: 416,
    severities: ["critical", "low"],
    legOutput: () => criticalLegOutput,
  },
];

/**
 * Fake legs. They also read the job table while running, which is the only
 * honest way to observe the `reviewing` state: it exists exactly for the
 * duration of the leg run.
 */
const simulatedLegRunnerLayer = (
  script: { current: SimulatedReview },
  observedWhileRunning: Array<ReviewJobStatus>,
) =>
  Layer.effect(
    LegRunner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return LegRunner.of({
        run: (config) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly status: ReviewJobStatus }>`
              SELECT status FROM nomior_review_jobs WHERE head_sha = ${script.current.headSha}
            `.pipe(Effect.orDie);
            const status = rows[0]?.status;
            if (status !== undefined && !observedWhileRunning.includes(status)) {
              observedWhileRunning.push(status);
            }
            return { rawOutput: script.current.legOutput(config.role) };
          }),
      });
    }),
  );

/**
 * The simulated jobs are enqueued at the start of the seeded week, and the
 * queue is FIFO (`nextEligible` orders by created_at). That is what makes
 * `processNext` pick ours instead of a demo card from the Queue column — the
 * scripted findings below belong to these two PRs, and handing them to
 * someone else's job would both misreport the run and consume the board a
 * developer opens the app to look at. `deleteSimulationArtifacts` then takes
 * the scaffolding back out — the jobs, their start-log rows and the memory
 * candidates their verdicts filed — so seed + simulate leaves exactly the
 * state seed alone would.
 */
const SIM_QUEUED_AT = SEED_WEEK_START;

const SIM_REPO = "nomior-dev/nomior-code";

const simulatedOriginRefs = SIMULATED_REVIEWS.map((review) => `${SIM_REPO}@${review.headSha}`);

const deleteSimulationArtifacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shas = SIMULATED_REVIEWS.map((review) => review.headSha);
  yield* sql`
    DELETE FROM nomior_review_job_starts
    WHERE job_id IN (SELECT id FROM nomior_review_jobs WHERE head_sha IN ${sql.in(shas)})
  `;
  yield* sql`DELETE FROM nomior_review_jobs WHERE head_sha IN ${sql.in(shas)}`;
  yield* sql`
    DELETE FROM nomior_memory_candidates WHERE origin_ref IN ${sql.in(simulatedOriginRefs)}
  `;
}).pipe(Effect.orDie);

const runReviewSection = Effect.gen(function* () {
  const script: { current: SimulatedReview } = { current: SIMULATED_REVIEWS[0]! };
  const candidateStore = yield* MemoryCandidateStore;

  // A previous run that died mid-section would leave its rows behind.
  yield* deleteSimulationArtifacts;

  const lines: Array<ReviewRunLine> = [];
  const gateObservations: Array<GateObservation> = [];

  const engineLayer = ReviewEngine.layer.pipe(
    Layer.provide(ReviewEngine.ReviewEngineConfig.layerStatic({ allowExternalPosting: false })),
    Layer.provide(
      ReviewEngine.ReviewRunContexts.layerStatic({
        legs: SIM_LEGS,
        playbook: SIM_PLAYBOOK,
        brief: {
          contextPacket: null,
          changeSummary: "Adds the Nomior seed scenario and the simulation harness.",
        },
      }),
    ),
    Layer.provide(ReviewPublisher.layerNoop),
  );

  for (const review of SIMULATED_REVIEWS) {
    script.current = review;
    const observed: Array<ReviewJobStatus> = [];

    const outcome = yield* Effect.gen(function* () {
      const engine = yield* ReviewEngine.ReviewEngine;
      const store = yield* ReviewJobStore.ReviewJobStore;
      const receipt = yield* store.enqueue({
        repo: SIM_REPO,
        target: { kind: "pull-request", number: review.pullRequestNumber },
        headSha: review.headSha,
        riskTier: "medium",
        now: SIM_QUEUED_AT,
      });
      const processed = yield* engine.processNext();
      const final = yield* store.getById(receipt.job.id);
      return { receipt, processed, final };
    }).pipe(
      Effect.provide(engineLayer.pipe(Layer.provide(simulatedLegRunnerLayer(script, observed)))),
    );

    // The whole section reports on our job; if the queue handed `processNext`
    // a different one, every line below would be about someone else's review.
    const processedId = "job" in outcome.processed ? outcome.processed.job.id : null;
    if (processedId !== outcome.receipt.job.id) {
      return yield* Effect.die(
        new Error(
          `nomior:simulate expected to process ${review.headSha} (${outcome.receipt.job.id}) but processNext returned ${processedId ?? outcome.processed.kind}`,
        ),
      );
    }

    const finalStatus = Option.isSome(outcome.final) ? outcome.final.value.status : "queued";
    const decision =
      outcome.processed.kind === "completed" ? outcome.processed.verdict.decision : "none";
    lines.push({
      jobId: outcome.receipt.job.id,
      headSha: review.headSha,
      transitions: ["queued", ...observed, finalStatus],
      decision,
      reasons: outcome.processed.kind === "completed" ? outcome.processed.verdict.reasons : [],
      followups:
        outcome.processed.kind === "completed" ? outcome.processed.verdict.followups.length : 0,
      published:
        outcome.processed.kind === "completed"
          ? outcome.processed.publish.detail
          : `outcome: ${outcome.processed.kind}`,
      severities: review.severities,
    });
    if (decision !== "none") {
      gateObservations.push({
        jobId: outcome.receipt.job.id,
        severities: review.severities,
        decision,
      });
    }
  }

  const pendingAfter = yield* candidateStore.list({ status: "pending" });
  yield* deleteSimulationArtifacts;

  // Counted by origin, not as a before/after delta: offers are idempotent, so
  // a delta would report 4 on the first run and 0 on every run after it.
  const simulatedOrigins = new Set(simulatedOriginRefs);
  return {
    lines,
    newMemoryCandidates: pendingAfter.filter(
      (candidate) => candidate.originRef !== null && simulatedOrigins.has(candidate.originRef),
    ).length,
    // Fed back into the promotion check: a finding a review filed is pending,
    // so it must not turn up in any answer either.
    pendingTexts: pendingAfter.map((candidate) => candidate.text),
    violations: checkGateDecision(gateObservations),
  };
});

// ===============================
// Section 4 — scheduler
// ===============================

const SCHEDULER_PROJECT = ProjectId.make("nomior-code");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_MAIN = ProviderInstanceId.make("inst-claude-main");
const CLAUDE_ALT = ProviderInstanceId.make("inst-claude-alt");

/**
 * Candidates are the two Claude instances: a leg belongs to one provider, so
 * the scheduler chooses within a driver, never across one.
 */
const SCHEDULER_CANDIDATES = [
  { instanceId: CLAUDE_MAIN, driver: CLAUDE_DRIVER },
  { instanceId: CLAUDE_ALT, driver: CLAUDE_DRIVER },
];

interface SchedulerStep {
  readonly step: string;
  readonly event: string;
  readonly emit: {
    readonly instanceId: string;
    readonly status: "ok" | "warning" | "limited";
    readonly usedPercent: number;
  } | null;
}

const SCHEDULER_STEPS: ReadonlyArray<SchedulerStep> = [
  { step: "1", event: "seeded state (main 28% used, studio limited at 94%)", emit: null },
  {
    step: "2",
    event: "studio's window resets (20% used)",
    emit: { instanceId: "inst-claude-alt", status: "ok", usedPercent: 20 },
  },
  {
    step: "3",
    event: "main is rejected mid-morning (97% used)",
    emit: { instanceId: "inst-claude-main", status: "limited", usedPercent: 97 },
  },
  {
    step: "4",
    event: "main recovers (10% used)",
    emit: { instanceId: "inst-claude-main", status: "ok", usedPercent: 10 },
  },
];

const runSchedulerSection = Effect.gen(function* () {
  const observer = yield* RateLimitObserver.RateLimitObserver;
  const scheduler = yield* InstanceScheduler.InstanceScheduler;
  const candidates = SCHEDULER_CANDIDATES;

  const lines: Array<SchedulerLine> = [];
  const observations: Array<SchedulerObservation> = [];

  for (const step of SCHEDULER_STEPS) {
    if (step.emit !== null) {
      yield* observer.ingest(
        rateLimitEvent({
          eventId: `nomior-sim-rl-${step.step}`,
          instanceId: step.emit.instanceId,
          driverKind: "claudeAgent",
          status: step.emit.status,
          usedPercent: step.emit.usedPercent,
          resetsAt: null,
          observedAt: "2026-08-29T09:05:00.000Z",
        }),
      );
    }

    const decision = yield* scheduler.pickForNewThread({
      projectId: SCHEDULER_PROJECT,
      candidates,
    });
    const headroomByInstance: Record<string, number> = {};
    for (const candidate of candidates) {
      const state = yield* observer.stateFor(candidate.instanceId);
      headroomByInstance[candidate.instanceId] = Option.isSome(state)
        ? instanceHeadroom(state.value)
        : 100;
    }

    lines.push({
      step: step.step,
      event: step.event,
      instanceId: decision.kind === "choice" ? decision.instanceId : "—",
      rule: decision.kind === "choice" ? decision.rule : decision.kind,
      reason: decision.kind === "choice" ? decision.reason : `scheduler ${decision.kind}`,
    });
    observations.push({ step: step.step, decision, headroomByInstance });
  }

  return { lines, violations: checkSchedulerDecision(observations) };
});

// ===============================
// Section 5 — meeting assembly
// ===============================

export const assembleSeedMeetings = (): ReadonlyArray<AssembledMeeting> =>
  assembleMeetings({
    transcripts: seedTranscriptSources,
    calendarEvents: seedCalendarSources,
    mailMessages: [],
  });

const runMeetingSection = Effect.sync(() => {
  const assembled = assembleSeedMeetings();
  const byMeetingId = new Map(
    assembled.map((meeting) => [meeting.transcript?.sourceId ?? meeting.meetingId, meeting]),
  );
  const violations: Array<Violation> = [];
  for (const meeting of seedMeetings) {
    const match = byMeetingId.get(meeting.meetingId);
    if (match?.calendarEvent?.value !== meeting.calendarEventId) {
      violations.push({
        kind: "meeting-unlinked",
        detail: `${meeting.meetingId} should link to ${meeting.calendarEventId} but resolved to ${match?.calendarEvent?.value ?? "nothing"}`,
      });
    }
  }
  return {
    total: assembled.length,
    linked: assembled.filter((meeting) => meeting.calendarEvent !== undefined).length,
    needConfirmation: assembled.filter((meeting) => meeting.needsConfirmation).length,
    violations,
  };
});

// ===============================
// The simulation
// ===============================

export const runSimulation = Effect.fn("nomiorSimulate")(function* () {
  const evalSection = yield* runEvalSection;
  const querySection = yield* runQuerySection;
  const reviewSection = yield* runReviewSection;
  const schedulerSection = yield* runSchedulerSection;
  const meetingSection = yield* runMeetingSection;

  const store = yield* MemoryCandidateStore;
  const pending = yield* store.list({ status: "pending" });
  const candidateViolations = checkCandidatePromotion({
    pendingTexts: [
      ...candidateMemories.map((memory) => memory.text),
      ...pending.map((candidate) => candidate.text),
      ...reviewSection.pendingTexts,
    ],
    retrievedTexts: querySection.retrievedTexts,
  });

  return {
    evalTable: evalSection.table,
    macroRecall: evalSection.macroRecall,
    queries: querySection.queries,
    reviews: reviewSection.lines,
    schedulerSteps: schedulerSection.lines,
    meetings: {
      total: meetingSection.total,
      linked: meetingSection.linked,
      needConfirmation: meetingSection.needConfirmation,
    },
    newMemoryCandidates: reviewSection.newMemoryCandidates,
    violations: [
      ...evalSection.violations,
      ...querySection.violations,
      ...reviewSection.violations,
      ...schedulerSection.violations,
      ...meetingSection.violations,
      ...candidateViolations,
    ],
  } satisfies SimulationReport;
});

/**
 * What `pnpm nomior:simulate` exits with. One broken invariant fails the run:
 * a demo that quietly leaks scope or approves over a critical finding is worse
 * than no demo.
 */
export const simulationExitCode = (report: SimulationReport): 0 | 1 =>
  report.violations.length === 0 ? 0 : 1;

const heading = (title: string): string => `\n${title}\n${"─".repeat(title.length)}`;

export const formatSimulationReport = (report: SimulationReport): string => {
  const lines: Array<string> = [];

  lines.push(heading("1. Retrieval evals (golden set, in-memory corpus)"));
  lines.push(report.evalTable);

  lines.push(heading("2. Context queries over the seeded capsules"));
  for (const query of report.queries) {
    lines.push(
      `[${query.probeId}] ${query.question}`,
      `    scope ${query.scope} · ${query.usedTokens}/${query.budgetTokens} tokens${
        query.truncated ? " · truncated" : ""
      }${query.expectedSourceCited ? "" : " · expected source NOT cited"}`,
    );
    for (const citation of query.citations) {
      lines.push(`    · ${citation}`);
    }
    if (query.citations.length === 0) {
      lines.push("    · (no results — as expected for a cross-capsule probe)");
    }
  }

  lines.push(heading("3. Review jobs through the state machine (fake legs)"));
  for (const review of report.reviews) {
    lines.push(
      `${review.headSha} [${review.severities.join(", ")}] → ${review.decision}`,
      `    board: ${review.transitions.join(" → ")}`,
      `    followups: ${review.followups} · posting: ${review.published}`,
    );
    for (const reason of review.reasons) {
      lines.push(`    · ${reason}`);
    }
  }
  lines.push(`Review findings filed as pending memory candidates: ${report.newMemoryCandidates}`);

  lines.push(heading("4. Scheduler under simulated rate-limit events"));
  for (const step of report.schedulerSteps) {
    lines.push(
      `${step.step}. ${step.event}`,
      `    → ${step.instanceId} (${step.rule}): ${step.reason}`,
    );
  }

  lines.push(heading("5. Meeting assembly (transcripts × calendar events)"));
  lines.push(
    `${report.meetings.linked}/${report.meetings.total} meetings linked to their calendar event, ${report.meetings.needConfirmation} need confirmation`,
  );

  lines.push(heading("Invariants"));
  if (report.violations.length === 0) {
    lines.push(
      "PASS — token budget held, no scope leaks, no approval over a blocking finding,",
      "       no pending candidate retrievable, scheduler never picked an exhausted instance.",
    );
  } else {
    for (const violation of report.violations) {
      lines.push(`FAIL [${violation.kind}] ${violation.detail}`);
    }
  }

  return lines.join("\n");
};
