# Review playbook

## Context

Nomior Code is a fork of t3code. Upstream files are shared with it, so a change
inside one is a merge conflict later: Nomior code is additive and lives under
`nomior/` paths, `packages/contracts/src/nomior.ts`, and the `/nomior` routes.
`pnpm nomior:check-manifest` is the arbiter of that boundary.

The server is event-sourced and Effect-heavy. Orchestration stays pure,
complexity belongs at the adapter boundary, and anything crossing the wire is
typed in `packages/contracts`.

Two rules the code enforces on itself, both with tests that fail loudly:
retrieval is scope-first (a query in one project must never surface another
project's material), and Nomior never reads provider credentials — see
`apps/server/src/nomior/safetyInvariants.test.ts`.

## Bar

No critical or high finding. A behaviour change with no test that would have
caught the old behaviour is a high finding. So is a new scope-crossing read, a
new outbound host, or a new path inside a provider home.

Weakening an existing check to make a change fit is not a trade-off to weigh;
report it.

## Verify

- `vp run --filter t3 typecheck` and `vp test run <the files the change
touches>`. Never the repo-wide suite: CI owns that.
- `pnpm nomior:check-manifest` — exit 0 or the fork boundary moved.
- Web changes: `vp run --filter @t3tools/web typecheck` and the panel tests
  under `apps/web/src/nomior/`.
- Seed fixtures are generated. If `apps/server/src/nomior/seed/` changed, run
  `vp run --filter t3 nomior:gen-fixtures` and confirm the diff is empty.
