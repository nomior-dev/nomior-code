import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Storage for the three panel surfaces that had no persistence.
 *
 * Before this migration the review board, the instances panel and the calendar
 * could only be rendered from bundled fixtures: `nomior_review_jobs` carries no
 * human-readable title, no finding severities and no manual-review flag; a
 * manual instance pin lived only in the scheduler's input; and calendar events
 * were converted straight into context records without ever being stored as
 * events. Each table below is the smallest addition that lets the live RPC port
 * answer one panel's read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // --- Review board -------------------------------------------------------
  // Title is what a human recognises the job by; the engine never reads it.
  yield* sql`ALTER TABLE nomior_review_jobs ADD COLUMN title TEXT`;

  // A manual-review request is a user asking a human to look, not a state
  // change: it must not disturb the engine's state machine, so it is its own
  // nullable timestamp rather than a `status` value.
  yield* sql`ALTER TABLE nomior_review_jobs ADD COLUMN manual_review_requested_at TEXT`;

  // Per-severity finding counts, replaced wholesale each time a leg reports.
  // Counts rather than rows: the board only ever renders the tally, and the
  // findings themselves belong to the review output the publisher posts.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_review_finding_counts (
      job_id TEXT PRIMARY KEY,
      blocker INTEGER NOT NULL DEFAULT 0,
      major INTEGER NOT NULL DEFAULT 0,
      minor INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;

  // --- Instances ----------------------------------------------------------
  // Manual pins. Present row = pinned; the scheduler treats a pin as the
  // highest-priority signal, so this is deliberately separate from the
  // advisory rate-limit table that gets rebuilt from provider events.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_instance_pins (
      instance_id TEXT PRIMARY KEY,
      pinned_at TEXT NOT NULL
    )
  `;

  // --- Calendar -----------------------------------------------------------
  // Events as events. The Google driver already turns them into context
  // records for retrieval; the calendar grid needs them back in their own
  // shape, with the account that owns them and the series they belong to.
  yield* sql`
    CREATE TABLE IF NOT EXISTS nomior_calendar_events (
      event_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      recurring_series_id TEXT,
      meeting_id TEXT,
      has_transcript INTEGER NOT NULL DEFAULT 0,
      has_notes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, event_id)
    )
  `;

  // The grid always asks for one window at a time, ordered by start.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_nomior_calendar_events_window
    ON nomior_calendar_events (starts_at, ends_at)
  `;
});
