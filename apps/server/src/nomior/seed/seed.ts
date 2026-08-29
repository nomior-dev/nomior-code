/**
 * seed - populate a dev database with the Nomior demo scenario.
 *
 * Idempotent by construction, in three different ways because the stores
 * differ: context sources replace themselves on `(kind, external_id)`,
 * connector accounts / cursors / rate-limit rows upsert on their keys, and
 * review jobs upsert on their fixed ids (their append-only start log is
 * cleared for the seed's own job ids first, since "append-only" and
 * "idempotent" only coexist if someone deletes).
 *
 * Run it under `DeterministicSeedRuntime` (see `deterministic.ts`) and a
 * re-seed is byte-identical, ids included.
 *
 * What the seeder deliberately does NOT write:
 * - provider instances, which live in server settings the user signs into;
 *   only their observable rate-limit state is seeded.
 * - connector records (calendar events, transcripts as connector rows): no
 *   store owns them yet. They live in the scenario, and every seeded meeting
 *   carries its calendar event id in provenance.
 *
 * @module nomior/seed/seed
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { NomiorContextLive } from "../NomiorRuntime.ts";
import * as ConnectorAccountStore from "../connectors/ConnectorAccountStore.ts";
import * as ConnectorCursorStore from "../connectors/ConnectorCursorStore.ts";
import { ConnectorAccountId, ConnectorDriverKind } from "../connectors/Records.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import { ContextIngest } from "../context/Ingest.ts";
import type { NomiorContextError } from "../context/Model.ts";
import { MemoryCandidateStore } from "../memory/MemoryCandidateStore.ts";
import * as RateLimitObserver from "../scheduler/RateLimitObserver.ts";
import { seedRateLimitEvents } from "./rateLimitEvents.ts";
import { severityCounts } from "./webFixtures.ts";
import {
  SEED_EXTERNAL_ID_PREFIX,
  seedCalendarEvents,
  seedConnectorAccounts,
  seedProviderInstances,
  seedReviewJobs,
  seedSchedulerAssignment,
  type SeedReviewJob,
} from "./scenario.ts";
import { candidateMemories, capsuleScope, seedSourceInputs } from "./sourceInputs.ts";

/**
 * Everything the seeder (and the simulator) needs on top of a `SqlClient`
 * with the migrations applied. The context half is `NomiorRuntime`'s own
 * graph, not a second composition of it: one broker, one embedding worker.
 */
export const NomiorSeedServices = Layer.mergeAll(
  NomiorContextLive,
  ConnectorAccountStore.layer,
  ConnectorCursorStore.layer,
  RateLimitObserver.layer,
);

export interface SeedSummary {
  readonly reset: boolean;
  readonly sources: number;
  readonly replacedSources: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly decisions: number;
  readonly tasks: number;
  readonly connectorAccounts: number;
  readonly connectorCursors: number;
  readonly memoryCandidates: number;
  /** Scenario-only: no store owns connector records yet. */
  readonly calendarEvents: number;
  readonly reviewJobs: number;
  readonly rateLimitStates: number;
}

export interface SeedOptions {
  /** Delete the seed's own rows first. Never touches rows the seed did not write. */
  readonly reset?: boolean | undefined;
}

export type SeedError =
  | PersistenceSqlError
  | NomiorContextError
  | ConnectorAccountStore.ConnectorAccountStoreError;

const reviewJobRef = (job: SeedReviewJob) => ({
  refKind: "pull-request",
  refValue: String(job.pullRequestNumber),
});

const countOf = (rows: ReadonlyArray<{ readonly count: number }>): number => rows[0]?.count ?? 0;

/**
 * Delete exactly what a previous seed wrote. Seeded context sources are
 * identified by their external-id prefix, everything else by the scenario's
 * own fixed ids — a reset can never eat a user's data.
 */
const resetSeedRows = Effect.fn("nomiorSeed.reset")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jobIds = seedReviewJobs.map((job) => job.jobId);
  const accountIds = seedConnectorAccounts.map((account) => account.accountId);
  const instanceIds = seedProviderInstances.map((instance) => instance.instanceId);
  const candidateOriginRefs = candidateMemories.map((memory) => memory.sourceLabel);

  yield* sql`
    DELETE FROM nomior_sources WHERE external_id LIKE ${`${SEED_EXTERNAL_ID_PREFIX}%`}
  `;
  yield* sql`DELETE FROM nomior_memory_candidates WHERE ${sql.in("origin_ref", candidateOriginRefs)}`;
  yield* sql`DELETE FROM nomior_review_job_starts WHERE ${sql.in("job_id", jobIds)}`;
  yield* sql`DELETE FROM nomior_review_jobs WHERE ${sql.in("id", jobIds)}`;
  yield* sql`DELETE FROM nomior_connector_cursors WHERE ${sql.in("account_id", accountIds)}`;
  yield* sql`DELETE FROM nomior_connector_accounts WHERE ${sql.in("account_id", accountIds)}`;
  yield* sql`DELETE FROM nomior_instance_rate_limits WHERE ${sql.in("instance_id", instanceIds)}`;
  yield* sql`
    DELETE FROM nomior_scheduler_assignments WHERE project_id = ${seedSchedulerAssignment.projectId}
  `;
});

const seedConnectors = Effect.fn("nomiorSeed.connectors")(function* () {
  const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
  const cursors = yield* ConnectorCursorStore.ConnectorCursorStore;

  for (const account of seedConnectorAccounts) {
    const accountId = ConnectorAccountId.make(account.accountId);
    yield* accounts.upsert({
      accountId,
      driverKind: ConnectorDriverKind.make(account.driverKind),
      displayName: account.displayName,
      config: account.config,
      status: "connected",
      createdAt: account.connectedAt,
      updatedAt: account.updatedAt,
    });
    for (const cursor of account.cursors) {
      yield* cursors.set(accountId, cursor.streamId, cursor.cursor);
    }
  }
});

/**
 * Candidate memories go through `MemoryCandidateStore.offer`, which can only
 * ever write `pending`. That is the point: the seed cannot fabricate an
 * approved memory, so "nothing promotes without approval" stays true of the
 * demo data too. Offers are content-addressed, hence idempotent.
 */
const seedMemoryCandidates = Effect.fn("nomiorSeed.memoryCandidates")(function* () {
  const store = yield* MemoryCandidateStore;
  for (const memory of candidateMemories) {
    yield* store.offer({
      source: memory.producer,
      scope: capsuleScope(memory.capsule),
      originRef: memory.sourceLabel,
      kind: "note",
      text: memory.text,
    });
  }
});

const seedReviewBoard = Effect.fn("nomiorSeed.reviewBoard")(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const job of seedReviewJobs) {
    const ref = reviewJobRef(job);
    yield* sql`
      INSERT INTO nomior_review_jobs (
        id, repo, ref_kind, ref_value, head_sha,
        status, pr_state, risk_tier, attempts, cooldown_until, last_started_at,
        failure_reason, verdict, created_at, updated_at,
        title, manual_review_requested_at
      )
      VALUES (
        ${job.jobId}, ${job.repo}, ${ref.refKind}, ${ref.refValue}, ${job.headSha},
        ${job.status}, ${job.pullRequestState}, ${job.riskTier}, ${job.attempts}, ${null}, ${job.lastStartedAt},
        ${job.failureReason}, ${job.verdict}, ${job.createdAt}, ${job.updatedAt},
        ${job.pullRequestTitle}, ${job.manualReviewRequested ? job.updatedAt : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        repo = excluded.repo,
        ref_kind = excluded.ref_kind,
        ref_value = excluded.ref_value,
        head_sha = excluded.head_sha,
        status = excluded.status,
        pr_state = excluded.pr_state,
        risk_tier = excluded.risk_tier,
        attempts = excluded.attempts,
        cooldown_until = excluded.cooldown_until,
        last_started_at = excluded.last_started_at,
        failure_reason = excluded.failure_reason,
        verdict = excluded.verdict,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        title = excluded.title,
        manual_review_requested_at = excluded.manual_review_requested_at
    `;

    // Severity tallies the board renders. Rewritten wholesale, like the job.
    const counts = severityCounts(job.findings.map((finding) => finding.severity));
    yield* sql`
      INSERT INTO nomior_review_finding_counts (job_id, blocker, major, minor, updated_at)
      VALUES (${job.jobId}, ${counts.blocker}, ${counts.major}, ${counts.minor}, ${job.updatedAt})
      ON CONFLICT (job_id) DO UPDATE SET
        blocker = excluded.blocker,
        major = excluded.major,
        minor = excluded.minor,
        updated_at = excluded.updated_at
    `;

    // The start log is append-only in production; for the seed it is
    // rewritten, or a second run would inflate the hourly quota.
    yield* sql`DELETE FROM nomior_review_job_starts WHERE job_id = ${job.jobId}`;
    if (job.lastStartedAt !== null) {
      yield* sql`
        INSERT INTO nomior_review_job_starts (job_id, started_at)
        VALUES (${job.jobId}, ${job.lastStartedAt})
      `;
    }
  }
});

const seedCalendar = Effect.fn("nomiorSeed.calendar")(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const event of seedCalendarEvents) {
    yield* sql`
      INSERT INTO nomior_calendar_events (
        event_id, account_id, title, starts_at, ends_at,
        recurring_series_id, meeting_id, has_transcript, has_notes, updated_at
      )
      VALUES (
        ${event.eventId}, ${event.accountId}, ${event.title}, ${event.startsAt}, ${event.endsAt},
        ${event.recurringSeriesId}, ${event.meetingId},
        ${event.meetingId === null ? 0 : 1}, ${event.meetingId === null ? 0 : 1},
        ${event.startsAt}
      )
      ON CONFLICT (account_id, event_id) DO UPDATE SET
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        recurring_series_id = excluded.recurring_series_id,
        meeting_id = excluded.meeting_id,
        has_transcript = excluded.has_transcript,
        has_notes = excluded.has_notes,
        updated_at = excluded.updated_at
    `;
  }
});

const seedSchedulerState = Effect.fn("nomiorSeed.scheduler")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observer = yield* RateLimitObserver.RateLimitObserver;

  for (const event of seedRateLimitEvents(seedProviderInstances)) {
    yield* observer.ingest(event);
  }

  yield* sql`
    INSERT INTO nomior_scheduler_assignments (project_id, instance_id, updated_at)
    VALUES (
      ${seedSchedulerAssignment.projectId},
      ${seedSchedulerAssignment.instanceId},
      ${seedSchedulerAssignment.updatedAt}
    )
    ON CONFLICT (project_id) DO UPDATE SET
      instance_id = excluded.instance_id,
      updated_at = excluded.updated_at
  `.pipe(Effect.mapError(toPersistenceSqlError("nomiorSeed.scheduler:assignment")));
});

/** Counts read back from the database, not from the scenario. */
const readSeedCounts = Effect.fn("nomiorSeed.counts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const seedLike = `${SEED_EXTERNAL_ID_PREFIX}%`;
  const accountIds = seedConnectorAccounts.map((account) => account.accountId);
  const jobIds = seedReviewJobs.map((job) => job.jobId);
  const instanceIds = seedProviderInstances.map((instance) => instance.instanceId);

  const sources = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_sources WHERE external_id LIKE ${seedLike}
  `;
  const chunks = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_chunks c
    JOIN nomior_sources s ON s.id = c.source_id
    WHERE s.external_id LIKE ${seedLike}
  `;
  const embeddings = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_embeddings e
    JOIN nomior_chunks c ON c.id = e.chunk_id
    JOIN nomior_sources s ON s.id = c.source_id
    WHERE s.external_id LIKE ${seedLike}
  `;
  const decisions = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_decisions d
    JOIN nomior_sources s ON s.id = d.source_id
    WHERE s.external_id LIKE ${seedLike}
  `;
  const tasks = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_tasks t
    JOIN nomior_sources s ON s.id = t.source_id
    WHERE s.external_id LIKE ${seedLike}
  `;
  const accounts = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_connector_accounts
    WHERE ${sql.in("account_id", accountIds)}
  `;
  const cursors = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_connector_cursors
    WHERE ${sql.in("account_id", accountIds)}
  `;
  const candidates = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_memory_candidates WHERE status = 'pending'
  `;
  const jobs = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_review_jobs WHERE ${sql.in("id", jobIds)}
  `;
  const rateLimits = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM nomior_instance_rate_limits
    WHERE ${sql.in("instance_id", instanceIds)}
  `;

  return {
    sources: countOf(sources),
    chunks: countOf(chunks),
    embeddings: countOf(embeddings),
    decisions: countOf(decisions),
    tasks: countOf(tasks),
    connectorAccounts: countOf(accounts),
    connectorCursors: countOf(cursors),
    memoryCandidates: countOf(candidates),
    reviewJobs: countOf(jobs),
    rateLimitStates: countOf(rateLimits),
  };
});

/**
 * Seed the database. Returns what is now in it, counted from the database
 * rather than from the scenario — a summary that cannot lie about a write
 * that did not happen.
 */
export const seedNomior = Effect.fn("nomiorSeed")(function* (options: SeedOptions = {}) {
  const ingest = yield* ContextIngest;
  const worker = yield* EmbeddingWorker;
  const reset = options.reset ?? false;

  if (reset) {
    yield* resetSeedRows().pipe(Effect.mapError(toPersistenceSqlError("nomiorSeed.reset")));
  }

  yield* seedConnectors();

  let replacedSources = 0;
  for (const source of seedSourceInputs) {
    const result = yield* ingest.ingestSource(source);
    if (result.replacedSourceId !== null) {
      replacedSources += 1;
    }
  }
  // Retrieval must work the moment the seeder returns, so the demo does not
  // race the background embedder.
  yield* worker.awaitIdle;

  yield* seedMemoryCandidates();
  yield* seedReviewBoard().pipe(Effect.mapError(toPersistenceSqlError("nomiorSeed.reviewBoard")));
  yield* seedCalendar().pipe(Effect.mapError(toPersistenceSqlError("nomiorSeed.calendar")));
  yield* seedSchedulerState();

  const counts = yield* readSeedCounts().pipe(
    Effect.mapError(toPersistenceSqlError("nomiorSeed.counts")),
  );

  return {
    reset,
    replacedSources,
    calendarEvents: seedCalendarEvents.length,
    ...counts,
  } satisfies SeedSummary;
});

export const formatSeedSummary = (summary: SeedSummary): string =>
  [
    `Nomior seed ${summary.reset ? "(reset)" : "(idempotent upsert)"} complete.`,
    `  context sources    ${summary.sources} (${summary.replacedSources} replaced)`,
    `  chunks / vectors   ${summary.chunks} / ${summary.embeddings}`,
    `  decisions / tasks  ${summary.decisions} / ${summary.tasks}`,
    `  connector accounts ${summary.connectorAccounts} (${summary.connectorCursors} cursors)`,
    `  memory candidates  ${summary.memoryCandidates} pending`,
    `  calendar events    ${summary.calendarEvents}`,
    `  review jobs        ${summary.reviewJobs}`,
    `  rate-limit states  ${summary.rateLimitStates}`,
  ].join("\n");
