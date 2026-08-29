# Nomior Code — fork working rules

This repo is a **private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)** (MIT). Upstream history is merged; `upstream` remote points at it. Product plan: `PLAN.md`. Fork accounting: `docs/nomior/FORK-MANIFEST.md`.

## The one rule that keeps this fork alive

Upstream ships ~15 commits/day. **Our code is additive; upstream files are touched only for registration lines, and every such touch is recorded in `docs/nomior/FORK-MANIFEST.md`.** CI (`pnpm nomior:check-manifest`) fails on undeclared modifications. When a sync conflicts, fix our side — never reshape upstream code to fit us.

Our code lives in:

- `apps/server/src/nomior/**` — context engine, connectors, scheduler, review engine
- `apps/server/src/mcp/toolkits/nomior/**` — the MCP toolkit
- `apps/web/src/**` (new files under nomior-owned dirs) — panels
- `apps/nomior-landing/**` — marketing site
- `packages/nomior-*` — shared Nomior libs

## Conventions (inherited from upstream, non-negotiable)

TypeScript + Effect (`Context.Service`, `Layer`, `Effect.fn`, `Stream`), Effect Schema for every wire/stored shape, `.ts` extensions on relative imports, no barrel files, no `any`, colocated `*.test.ts`. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` (or `vp run --filter <pkg> test`) before finishing.

## Migrations

**Nomior migrations NEVER go in the upstream registry.** There is exactly one
Nomior migrator: `apps/server/src/nomior/persistence/Migrations.ts`. It runs its
own numbered sequence out of `apps/server/src/nomior/persistence/Migrations/`
and records progress in `nomior_sql_migrations`.

Adding one: create `Migrations/<next id>_<Name>.ts` (gapless, ascending, unique
name), append one entry to `nomiorMigrationEntries`, add a row to
`STATE-INVENTORY.md`. That is the whole procedure — no upstream file changes.

- Never add an entry to `apps/server/src/persistence/Migrations.ts` or a file to
  `apps/server/src/persistence/Migrations/`. Upstream appends ids there daily;
  a Nomior entry collides on both the filename and the registry slot at the
  next sync, and `migrate-dev-db`'s slot check turns that into a hard failure
  on every dev database that already applied our number.
- Never stand up a second migrator with its own ledger table. Two ledgers means
  two orderings and no single answer to "what schema does this database have".
- DDL is `IF NOT EXISTS` throughout so a replay is a no-op; `Migrations.test.ts`
  enforces gapless numbering and asserts that re-running every migration body
  leaves `sqlite_master` byte-identical.
- Wiring is already done: the shared sqlite setup layer runs
  `runNomiorMigrations()` immediately after upstream's `runMigrations()`
  (`apps/server/src/persistence/Layers/Sqlite.ts`), so production, the CLI, and
  every test using `SqlitePersistenceMemory` get the same schema. That one line
  is the fork's whole migration footprint in upstream code.

## Safety invariants

- **Never read, store, or proxy provider credentials.** Multi-account = local profiles (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) that the user signed into themselves; the scheduler uses only rate-limit events the CLIs already emit.
- Nothing leaves the machine without explicit user selection. Cloud sync carries product data only — never credentials.
- Memory mirrors into `AGENTS.md`/Claude memory dirs are **explicit user-triggered exports with owned markers**, never automatic.
- Every context query is scope-first; a query in one project must never surface another project's data.
- Heavy compute (embeddings, rerank, STT) runs in cancellable bounded-concurrency workers, off the request path.
- Review posts to external forges only after explicit approval; the verdict gate is deterministic code, never a model.

## Upstream sync

Daily job syncs from upstream **stable tags** (not `main`); a canary builds against nightly for early warning. On lockfile conflict: take upstream's `pnpm-lock.yaml`, then regenerate (`scripts/nomior/resolve-lockfile.sh`). Never hand-merge the lockfile.

## History hygiene

The repo is private but may be opened later: no secrets in any commit (gitleaks runs in CI), clean commit messages, Conventional Commits.
