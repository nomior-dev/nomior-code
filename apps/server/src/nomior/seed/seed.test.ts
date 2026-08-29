import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DeterministicSeedRuntime } from "./deterministic.ts";
import {
  SEED_EXTERNAL_ID_PREFIX,
  SEED_NOW,
  seedCalendarEvents,
  seedConnectorAccounts,
  seedMeetings,
  seedProviderInstances,
  seedReviewJobs,
} from "./scenario.ts";
import { NomiorSeedServices, seedNomior, type SeedError, type SeedSummary } from "./seed.ts";
import { candidateMemories, seedSourceInputs } from "./sourceInputs.ts";

/**
 * Each seed run gets a freshly built `DeterministicSeedRuntime`, which is what
 * a second `pnpm nomior:seed` in a new process gets: the counter-seeded crypto
 * restarts, so identical input must produce identical ids.
 */
// provideMerge, not provide: `ContextIngest` reads the clock from the effect's
// own context, so the frozen clock has to reach the effect and not just the
// layers behind it.
const seedRuntime = NomiorSeedServices.pipe(
  Layer.provideMerge(
    DeterministicSeedRuntime(SEED_NOW).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

const runSeed = (
  options?: Parameters<typeof seedNomior>[0],
): Effect.Effect<SeedSummary, SeedError, SqlClient.SqlClient> =>
  seedNomior(options).pipe(Effect.provide(seedRuntime));

interface SourceRow {
  readonly id: string;
  readonly kind: string;
  readonly externalId: string;
  readonly title: string;
  readonly ingestedAt: string;
}

const seedLike = `${SEED_EXTERNAL_ID_PREFIX}%`;

const readSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<SourceRow>`
    SELECT id, kind, external_id AS "externalId", title, ingested_at AS "ingestedAt"
    FROM nomior_sources
    WHERE external_id LIKE ${seedLike}
    ORDER BY external_id
  `;
});

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ${sql.literal(table)}
    `;
    return rows[0]?.count ?? 0;
  });

/** Signed-out instances emit no rate-limit event, so they have no state row. */
const seedRateLimitedInstances = seedProviderInstances.filter(
  (instance) => instance.health !== "signed-out",
);

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer)));

layer("seedNomior", (it) => {
  it.effect("writes the whole scenario", () =>
    Effect.gen(function* () {
      const summary = yield* runSeed();
      assert.strictEqual(summary.sources, seedSourceInputs.length);
      assert.strictEqual(summary.chunks, summary.embeddings);
      assert.isAtLeast(summary.chunks, summary.sources);
      assert.strictEqual(summary.reviewJobs, seedReviewJobs.length);
      assert.strictEqual(summary.connectorAccounts, seedConnectorAccounts.length);
      assert.strictEqual(summary.memoryCandidates, candidateMemories.length);
      assert.strictEqual(summary.calendarEvents, seedCalendarEvents.length);
      assert.strictEqual(summary.rateLimitStates, seedRateLimitedInstances.length);
    }),
  );

  it.effect("is idempotent: a second run replaces rather than duplicates", () =>
    Effect.gen(function* () {
      const first = yield* runSeed();
      const firstSources = yield* readSources;
      const second = yield* runSeed();
      const secondSources = yield* readSources;

      assert.strictEqual(second.sources, first.sources);
      assert.strictEqual(second.chunks, first.chunks);
      assert.strictEqual(second.decisions, first.decisions);
      assert.strictEqual(second.tasks, first.tasks);
      assert.strictEqual(second.reviewJobs, first.reviewJobs);
      assert.strictEqual(second.memoryCandidates, first.memoryCandidates);
      // Replacement, not insertion: every source was already there.
      assert.strictEqual(second.replacedSources, seedSourceInputs.length);
      assert.deepStrictEqual(secondSources, firstSources);
    }),
  );

  it.effect("stamps every source with the frozen clock, not wall time", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sources = yield* readSources;
      assert.isAtLeast(sources.length, 1);
      for (const source of sources) {
        assert.strictEqual(source.ingestedAt, SEED_NOW, `${source.externalId} ingested_at`);
      }
    }),
  );

  it.effect("leaves no chunk, vector, decision or task without its source", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const orphans = yield* sql<{ readonly what: string; readonly count: number }>`
        SELECT 'chunk' AS what, COUNT(*) AS count FROM nomior_chunks c
          LEFT JOIN nomior_sources s ON s.id = c.source_id WHERE s.id IS NULL
        UNION ALL
        SELECT 'embedding', COUNT(*) FROM nomior_embeddings e
          LEFT JOIN nomior_chunks c ON c.id = e.chunk_id WHERE c.id IS NULL
        UNION ALL
        SELECT 'decision', COUNT(*) FROM nomior_decisions d
          LEFT JOIN nomior_sources s ON s.id = d.source_id WHERE s.id IS NULL
        UNION ALL
        SELECT 'task', COUNT(*) FROM nomior_tasks t
          LEFT JOIN nomior_sources s ON s.id = t.source_id WHERE s.id IS NULL
        UNION ALL
        SELECT 'scope', COUNT(*) FROM nomior_source_scopes sc
          LEFT JOIN nomior_sources s ON s.id = sc.source_id WHERE s.id IS NULL
        UNION ALL
        SELECT 'cursor', COUNT(*) FROM nomior_connector_cursors cu
          LEFT JOIN nomior_connector_accounts a ON a.account_id = cu.account_id
          WHERE a.account_id IS NULL
        UNION ALL
        SELECT 'start', COUNT(*) FROM nomior_review_job_starts st
          LEFT JOIN nomior_review_jobs j ON j.id = st.job_id WHERE j.id IS NULL
      `;
      for (const row of orphans) {
        assert.strictEqual(row.count, 0, `${row.what} rows without a parent`);
      }
    }),
  );

  it.effect("binds every seeded source to at least one scope", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const unscoped = yield* sql<{ readonly externalId: string }>`
        SELECT s.external_id AS "externalId" FROM nomior_sources s
        LEFT JOIN nomior_source_scopes sc ON sc.source_id = s.id
        WHERE s.external_id LIKE ${seedLike} AND sc.source_id IS NULL
      `;
      assert.deepStrictEqual(
        unscoped.map((row) => row.externalId),
        [],
      );
    }),
  );

  it.effect("fills every board column and keeps verdict and status agreeing", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const jobs = yield* sql<{
        readonly id: string;
        readonly status: string;
        readonly verdict: string | null;
      }>`
        SELECT id, status, verdict FROM nomior_review_jobs
        WHERE ${sql.in(
          "id",
          seedReviewJobs.map((job) => job.jobId),
        )}
        ORDER BY id
      `;

      assert.deepStrictEqual(
        jobs.map((job) => job.id),
        [...seedReviewJobs].map((job) => job.jobId).sort(),
      );
      assert.deepStrictEqual(
        new Set(jobs.map((job) => job.status)),
        new Set(["queued", "reviewing", "waiting-external", "approved", "not-approved"]),
      );
      for (const job of jobs) {
        const terminal = job.status === "approved" || job.status === "not-approved";
        assert.strictEqual(
          job.verdict !== null,
          terminal,
          `${job.id}: only a terminal job carries a verdict`,
        );
      }
    }),
  );

  it.effect("files candidate memories as pending and nothing else", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string; readonly count: number }>`
        SELECT status, COUNT(*) AS count FROM nomior_memory_candidates GROUP BY status
      `;
      assert.deepStrictEqual(rows, [{ status: "pending", count: candidateMemories.length }]);
    }),
  );

  it.effect("records rate-limit state only for instances that are signed in", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly instanceId: string }>`
        SELECT instance_id AS "instanceId" FROM nomior_instance_rate_limits ORDER BY instance_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.instanceId),
        seedRateLimitedInstances.map((instance) => instance.instanceId).sort(),
      );
    }),
  );

  it.effect("reset removes the seed's rows and leaves everything else alone", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO nomior_review_jobs (
          id, repo, ref_kind, ref_value, head_sha,
          status, risk_tier, attempts, cooldown_until, last_started_at,
          failure_reason, verdict, created_at, updated_at
        ) VALUES (
          'not-a-seed-job', 'someone/else', 'pull-request', '9001', 'deadbee',
          'queued', 'low', 0, NULL, NULL, NULL, NULL, ${SEED_NOW}, ${SEED_NOW}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      const summary = yield* runSeed({ reset: true });
      assert.isTrue(summary.reset);
      // Reset deleted the seed's sources before re-ingesting them, so nothing
      // was replaced this time.
      assert.strictEqual(summary.replacedSources, 0);
      assert.strictEqual(summary.sources, seedSourceInputs.length);

      const survivors = yield* sql<{ readonly id: string }>`
        SELECT id FROM nomior_review_jobs WHERE id = 'not-a-seed-job'
      `;
      assert.strictEqual(survivors.length, 1, "reset ate a row the seed did not write");
      assert.strictEqual(yield* countRows("nomior_review_jobs"), seedReviewJobs.length + 1);
    }),
  );

  it.effect("keeps the two capsules apart in the scope table", () =>
    Effect.gen(function* () {
      yield* runSeed();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly externalId: string;
        readonly scopeValue: string;
      }>`
        SELECT s.external_id AS "externalId", sc.scope_value AS "scopeValue"
        FROM nomior_source_scopes sc
        JOIN nomior_sources s ON s.id = sc.source_id
        WHERE sc.scope_kind = 'capsule' AND s.external_id LIKE ${seedLike}
      `;
      const capsulesBySource = new Map<string, Set<string>>();
      for (const row of rows) {
        const set = capsulesBySource.get(row.externalId) ?? new Set<string>();
        set.add(row.scopeValue);
        capsulesBySource.set(row.externalId, set);
      }
      assert.strictEqual(capsulesBySource.size, seedSourceInputs.length);
      for (const [externalId, capsules] of capsulesBySource) {
        assert.strictEqual(capsules.size, 1, `${externalId} sits in two capsules`);
      }
      assert.deepStrictEqual(
        new Set([...capsulesBySource.values()].flatMap((set) => [...set])),
        new Set(["nomior-code", "home-studio"]),
      );
    }),
  );
});

describe("the scenario the seeder writes", () => {
  it("gives every meeting a calendar event, and every meeting event a meeting", () => {
    const eventIds = new Set(seedCalendarEvents.map((event) => event.eventId));
    for (const meeting of seedMeetings) {
      assert.isTrue(
        eventIds.has(meeting.calendarEventId),
        `${meeting.meetingId} points at a calendar event that does not exist`,
      );
    }
    const meetingIds = new Set(seedMeetings.map((meeting) => meeting.meetingId));
    for (const event of seedCalendarEvents) {
      if (event.meetingId !== null) {
        assert.isTrue(meetingIds.has(event.meetingId), `${event.eventId} points at no meeting`);
      }
    }
  });

  it("keeps ids unique across meetings, memories, jobs, events and instances", () => {
    const groups = {
      meetings: seedMeetings.map((meeting) => meeting.meetingId),
      jobs: seedReviewJobs.map((job) => job.jobId),
      events: seedCalendarEvents.map((event) => event.eventId),
      instances: seedProviderInstances.map((instance) => instance.instanceId),
      accounts: seedConnectorAccounts.map((account) => account.accountId),
    };
    for (const [name, ids] of Object.entries(groups)) {
      assert.strictEqual(new Set(ids).size, ids.length, `${name} has a duplicate id`);
    }
  });
});
