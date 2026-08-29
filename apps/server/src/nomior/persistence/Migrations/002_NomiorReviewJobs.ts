import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_review_jobs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_value TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      last_started_at TEXT,
      failure_reason TEXT,
      verdict TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Idempotent job receipts: one job per (repo, ref, head sha). A re-submitted
  // sha returns the existing job instead of enqueueing a duplicate review.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nomior_review_jobs_seen_sha
    ON nomior_review_jobs(repo, ref_kind, ref_value, head_sha)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_review_jobs_status
    ON nomior_review_jobs(status, cooldown_until)
  `;

  // Append-only log of review STARTS. The hourly quota counts rows here, not
  // jobs: a job retried three times in the window really did start three
  // reviews, which `nomior_review_jobs.last_started_at` alone cannot express.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_review_job_starts (
      job_id TEXT NOT NULL,
      started_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_review_job_starts_started_at
    ON nomior_review_job_starts(started_at)
  `;
});
