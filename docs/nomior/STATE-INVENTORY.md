# Nomior state inventory

## Context engine

Every Nomior store, where it lives, and how derived state rebuilds. All
tables live in the main server database (`state.sqlite`) and are created by
migration `044_NomiorContextBroker`.

| Store                               | Kind                             | Source of truth                                        | Rebuild                                                                                                                                                     |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nomior_sources`                    | canonical                        | connector/ingest input                                 | re-ingest from the connector (`(kind, external_id)` replaces atomically)                                                                                    |
| `nomior_source_scopes`              | canonical                        | ingest input scopes                                    | re-ingest                                                                                                                                                   |
| `nomior_chunks`                     | canonical (normalized)           | source segments                                        | re-ingest; chunk ids are deterministic `${sourceId}/${ordinal}`                                                                                             |
| `nomior_chunks_fts`                 | derived (FTS5, external content) | `nomior_chunks`                                        | kept in sync by triggers; full rebuild: `INSERT INTO nomior_chunks_fts(nomior_chunks_fts) VALUES('rebuild')`                                                |
| `nomior_embeddings`                 | derived                          | `nomior_chunks` + embedding model                      | `EmbeddingWorker.drainPending` regenerates missing vectors for the active model; vectors are keyed by `model_id`, so a model change never corrupts old data |
| `nomior_decisions` / `nomior_tasks` | canonical (extracted)            | ingest input, evidence spans into canonical chunk text | re-ingest                                                                                                                                                   |

Nothing here indexes secrets or credentials; ingest receives already-normalized
segment text from connectors, never raw filesystem or credential material.

Every store the Nomior layer owns, per the review constraint: migrations +
an inventory entry, and derived state must be rebuildable from source.
Upstream stores are not listed — this covers only what Nomior adds.

## Connectors track

| State                                                       | Where                                                                  | Migrations                                                                               | Rebuildable?                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `nomior_connector_accounts`                                 | server SQLite (shared `SqlClient` DB)                                  | `src/nomior/connectors/Migrations/` via own migrator table `nomior_connector_migrations` | No — user configuration (connected accounts + selector config). Backed up with the DB.                      |
| `nomior_connector_cursors`                                  | server SQLite (shared `SqlClient` DB)                                  | same                                                                                     | Yes — deleting a cursor row re-baselines that stream on the next sync (drivers report `cursorInvalidated`). |
| `nomior_connector_migrations`                               | server SQLite (shared `SqlClient` DB)                                  | self (migrator bookkeeping)                                                              | N/A — migrator ledger, deliberately separate from upstream's migration array.                               |
| Google OAuth token sets (`nomior-google-token-<accountId>`) | upstream `ServerSecretStore` (0600 files under the server secrets dir) | none (opaque per-account secrets)                                                        | No — re-issued by reconnecting the account; never stored anywhere else.                                     |

Reads with no owned state: the Anarlog connector opens the Anarlog app's
SQLite store strictly `readOnly` and its markdown export read-only; neither
is Nomior state.
