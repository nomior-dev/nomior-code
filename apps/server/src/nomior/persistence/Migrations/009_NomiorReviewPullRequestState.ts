import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where the pull request stands, alongside where its review stands.
 *
 * The two are different facts and the board needs both: a review can sit in
 * `waiting-external` forever after its pull request merged, and a card for
 * finished work is a card nobody can act on. Existing rows default to `open`,
 * which is what every row was implicitly asserting before this column existed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite has no `ADD COLUMN IF NOT EXISTS`, and every migration body must
  // survive a bare replay — see the note in 006.
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('nomior_review_jobs') WHERE name = 'pr_state'
  `;
  if (existing.length === 0) {
    yield* sql.unsafe(
      `ALTER TABLE nomior_review_jobs ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'open'`,
    );
  }

  // The board's read is "open pull requests, newest first"; this is the index
  // that keeps it one scan of the open rows rather than of every job ever run.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_review_jobs_board
    ON nomior_review_jobs(pr_state, updated_at DESC)
  `;
});
