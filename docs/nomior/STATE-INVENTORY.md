# Nomior state inventory

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
