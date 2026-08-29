# Fork manifest — upstream files Nomior modifies

Every touch of an upstream file is a registration line and is listed here.
CI flags a sync when one of these files changed upstream. Everything else
Nomior ships is additive (`apps/server/src/nomior/**`, `docs/nomior/**`).

| Upstream file                               | Why                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/persistence/Migrations.ts` | Register migration `044_NomiorContextBroker` (import + one entry in `migrationEntries`). |
| `apps/server/package.json`                  | Add the `nomior:eval-retrieval` script (retrieval quality gate).                         |
