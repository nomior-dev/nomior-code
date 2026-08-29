# Nomior state inventory

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
