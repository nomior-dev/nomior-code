# Nomior state inventory

Every store the Nomior layer owns, per the review constraint: migrations + an
inventory entry, and derived state must be rebuildable from source. Upstream
stores are not listed — this covers only what Nomior adds.

All Nomior tables live in the main server database (`state.sqlite`, the same
`SqlClient` upstream provides) and are created by the single Nomior migrator,
`apps/server/src/nomior/persistence/Migrations.ts`. It tracks itself in
`nomior_sql_migrations`, never in upstream's `effect_sql_migrations` — see the
Migrations section of `WORKING-RULES.md`.

| Table                          | Migration                    | Kind                             | Source of truth                                           | Rebuild                                                                                                                                                           |
| ------------------------------ | ---------------------------- | -------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nomior_instance_rate_limits`  | `001_NomiorSchedulerState`   | derived                          | provider runtime rate-limit events                        | Yes — rows are overwritten by newer events; an empty table means "no signal yet", so dropping it is always safe                                                   |
| `nomior_scheduler_assignments` | `001_NomiorSchedulerState`   | canonical (advisory)             | scheduler decisions for NEW threads                       | No, but deleting a row only drops stickiness for that project — it never moves an existing thread                                                                 |
| `nomior_review_jobs`           | `002_NomiorReviewJobs`       | canonical                        | review submissions                                        | No — one job per `(repo, ref, head_sha)`; re-submitting a sha returns the existing job                                                                            |
| `nomior_review_job_starts`     | `002_NomiorReviewJobs`       | canonical (append-only)          | review engine starts                                      | No — the hourly quota counts starts, which `nomior_review_jobs.last_started_at` cannot express                                                                    |
| `nomior_sources`               | `003_NomiorContextBroker`    | canonical                        | connector/ingest input                                    | Yes — re-ingest from the connector (`(kind, external_id)` replaces atomically)                                                                                    |
| `nomior_source_scopes`         | `003_NomiorContextBroker`    | canonical                        | ingest input scopes                                       | Yes — re-ingest                                                                                                                                                   |
| `nomior_chunks`                | `003_NomiorContextBroker`    | canonical (normalized)           | source segments                                           | Yes — re-ingest; chunk ids are deterministic `${sourceId}/${ordinal}`                                                                                             |
| `nomior_chunks_fts`            | `003_NomiorContextBroker`    | derived (FTS5, external content) | `nomior_chunks`                                           | Yes — kept in sync by triggers; full rebuild: `INSERT INTO nomior_chunks_fts(nomior_chunks_fts) VALUES('rebuild')`                                                |
| `nomior_embeddings`            | `003_NomiorContextBroker`    | derived                          | `nomior_chunks` + embedding model                         | Yes — `EmbeddingWorker.drainPending` regenerates missing vectors for the active model; vectors are keyed by `model_id`, so a model change never corrupts old data |
| `nomior_decisions`             | `003_NomiorContextBroker`    | canonical (extracted)            | ingest input, evidence spans into canonical chunk text    | Yes — re-ingest                                                                                                                                                   |
| `nomior_tasks`                 | `003_NomiorContextBroker`    | canonical (extracted)            | ingest input, evidence spans into canonical chunk text    | Yes — re-ingest                                                                                                                                                   |
| `nomior_connector_accounts`    | `004_NomiorConnectorTables`  | canonical                        | user configuration (connected accounts + selector config) | No — backed up with the DB                                                                                                                                        |
| `nomior_connector_cursors`     | `004_NomiorConnectorTables`  | derived (resumable)              | per-stream sync position                                  | Yes — deleting a cursor row re-baselines that stream on the next sync (drivers report `cursorInvalidated`)                                                        |
| `nomior_memory_candidates`     | `005_NomiorMemoryCandidates` | unused                           | nothing                                                   | N/A — no code reads or writes it since findings started going straight to memory; the table is left in place because dropping one is destructive                  |
| `nomior_sql_migrations`        | migrator bookkeeping         | ledger                           | self                                                      | N/A — deliberately separate from upstream's `effect_sql_migrations`                                                                                               |

Nothing here indexes secrets or credentials; ingest receives already-normalized
segment text from connectors, never raw filesystem or credential material.

## State outside SQLite

| State                                                       | Where                                                                  | Rebuildable?                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Google OAuth token sets (`nomior-google-token-<accountId>`) | upstream `ServerSecretStore` (0600 files under the server secrets dir) | No — re-issued by reconnecting the account; never stored elsewhere. |

Read-only input, owned by someone else: Claude Code's per-project memory notes
under `<config dir>/projects/<slugged workspace root>/memory/*.md`. Every
`~/.claude*` directory is one account and they are read together;
`ClaudeMemories` imports them into `nomior_sources` as `memory` sources on the
search path, keyed `claude-memory:<projectId>:<note name>` and refreshed by
mtime. Nomior never writes into a Claude config directory — that is pinned by
`safetyInvariants.test.ts`, which also holds the import to that one subtree.

## Retired

`nomior_connector_migrations` was the connectors track's own migrator ledger.
`004_NomiorConnectorTables` drops it; the connector tables it used to track are
now entries in the single Nomior migrator.
