# Fork manifest — upstream files Nomior Code modifies

The diff budget for the fork. Every upstream-owned file we modify (any file
that exists in the merge-base with `upstream/main`) is declared here with a
one-line reason. CI (`pnpm nomior:check-manifest`, backed by
`scripts/nomior/check-fork-manifest.ts`) computes the real set of modified
upstream files and fails on any modification not declared below. Purely
additive files (`apps/server/src/nomior/**`, `packages/nomior-*`,
`docs/nomior/**`, `scripts/nomior/**`, `.github/workflows/nomior-*.yml`) never
need an entry.

Keep entries to registration lines, branding display strings, and policy files.
Anything larger belongs in an additive module — see the fork discipline section
of `PLAN.md`.

## Format

The checker parses the single markdown table between the `fork-manifest`
markers. One row per file: the repo-relative path in backticks, then the
reason. Rows must be unique by path. Everything outside the markers is prose
for humans and ignored by tooling.

<!-- fork-manifest:begin -->

| Path                                                          | Reason                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                | root script registration: `nomior:check-manifest`                                                                                                                                                                          |
| `.gitattributes`                                              | `pnpm-lock.yaml merge=binary` so sync merges never hand-merge the lockfile                                                                                                                                                 |
| `pnpm-lock.yaml`                                              | regenerated whenever nomior workspace packages change deps; on sync conflict resolved per the lockfile policy below                                                                                                        |
| `packages/shared/package.json`                                | subpath export registration: `./nomiorBrand`                                                                                                                                                                               |
| `packages/client-runtime/package.json`                        | subpath export registration: `./state/nomior`                                                                                                                                                                              |
| `apps/desktop/src/app/DesktopEnvironment.ts`                  | branding: `APP_BASE_NAME` sourced from `nomiorBrand`                                                                                                                                                                       |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts`             | branding: display-name assertions use the `nomiorBrand` constant                                                                                                                                                           |
| `apps/desktop/src/window/DesktopApplicationMenu.ts`           | branding: up-to-date dialog uses the `nomiorBrand` constant                                                                                                                                                                |
| `apps/web/src/branding.ts`                                    | branding: web fallback base name sourced from `nomiorBrand`                                                                                                                                                                |
| `apps/web/src/branding.test.ts`                               | branding: display-name assertions use the `nomiorBrand` constant                                                                                                                                                           |
| `apps/web/src/components/SplashScreen.tsx`                    | branding: splash alt/aria labels use `APP_BASE_NAME`                                                                                                                                                                       |
| `apps/web/src/components/settings/ThemePreviewCircles.tsx`    | branding: default theme card label uses `APP_BASE_NAME`                                                                                                                                                                    |
| `apps/web/src/versionSkew.ts`                                 | branding: version-mismatch hint uses `APP_BASE_NAME`                                                                                                                                                                       |
| `apps/web/src/versionSkew.test.ts`                            | branding: hint fixture derives from the mocked `APP_BASE_NAME`                                                                                                                                                             |
| `apps/web/src/connection/clientMetadata.ts`                   | branding: client labels (`Desktop`/`Web`) use `APP_BASE_NAME`                                                                                                                                                              |
| `apps/web/src/connection/clientMetadata.test.ts`              | branding: label assertion uses `APP_BASE_NAME`                                                                                                                                                                             |
| `apps/web/src/components/desktopUpdate.logic.ts`              | branding: update/Rosetta copy uses `APP_BASE_NAME`                                                                                                                                                                         |
| `apps/web/src/components/desktopUpdate.logic.test.ts`         | branding: copy assertions use `APP_BASE_NAME`                                                                                                                                                                              |
| `apps/web/src/components/ChatView.tsx`                        | branding: PR-unavailable error copy uses `APP_BASE_NAME`                                                                                                                                                                   |
| `apps/web/src/components/RightPanelTabs.tsx`                  | branding: browser-preview disabled reason uses `APP_BASE_NAME`                                                                                                                                                             |
| `apps/web/src/components/preview/PreviewPanel.tsx`            | branding: preview desktop-only copy uses `APP_BASE_NAME`                                                                                                                                                                   |
| `apps/web/src/components/settings/ThemeSettings.tsx`          | branding: theme settings intro copy uses `APP_BASE_NAME`                                                                                                                                                                   |
| `apps/web/src/components/settings/ThemeImportDialog.tsx`      | branding: theme drop-zone copy uses `APP_BASE_NAME`                                                                                                                                                                        |
| `apps/web/src/components/settings/KeybindingsSettings.tsx`    | branding: keybinding hint copy uses `APP_BASE_NAME`                                                                                                                                                                        |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`    | branding: restart/WSL/Tailscale dialog copy uses `APP_BASE_NAME`                                                                                                                                                           |
| `apps/web/src/components/settings/providerStatus.ts`          | branding: provider-disabled detail uses `APP_BASE_NAME`                                                                                                                                                                    |
| `apps/web/src/components/desktop/SshPasswordPromptDialog.tsx` | branding: SSH password prompt copy uses `APP_BASE_NAME`                                                                                                                                                                    |
| `apps/web/src/components/cloud/RelayClientInstallDialog.tsx`  | branding: relay install copy uses `APP_BASE_NAME` (T3 Connect service name kept)                                                                                                                                           |
| `apps/web/src/cloud/linkEnvironment.ts`                       | branding: relay install error copy uses `APP_BASE_NAME`                                                                                                                                                                    |
| `apps/web/src/routes/_chat.tsx`                               | branding: preview desktop-only toast uses `APP_BASE_NAME`                                                                                                                                                                  |
| `apps/web/src/routes/_chat.pull-requests.tsx`                 | branding: PR-unavailable error copy uses `APP_BASE_NAME`                                                                                                                                                                   |
| `apps/desktop/src/app/DesktopApp.ts`                          | branding: startup failure dialog title uses the `nomiorBrand` constant                                                                                                                                                     |
| `apps/desktop/src/backend/DesktopBackendPool.ts`              | branding: WSL fallback dialog copy uses the `nomiorBrand` constant                                                                                                                                                         |
| `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`     | branding: auth client label uses the `nomiorBrand` constant                                                                                                                                                                |
| `apps/desktop/src/linuxSecretStorage.ts`                      | branding: keyring remediation copy uses the `nomiorBrand` constant                                                                                                                                                         |
| `apps/desktop/src/ssh/DesktopSshEnvironment.ts`               | branding: SSH auth error copy uses the `nomiorBrand` constant                                                                                                                                                              |
| `apps/desktop/src/ssh/DesktopSshEnvironment.test.ts`          | branding: SSH auth error assertion uses the `nomiorBrand` constant                                                                                                                                                         |
| `apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts`           | branding: SSH prompt error copy uses the `nomiorBrand` constant                                                                                                                                                            |
| `apps/desktop/src/wsl/DesktopWslEnvironment.ts`               | branding: WSL prebuild-missing copy uses the `nomiorBrand` constant                                                                                                                                                        |
| `.github/workflows/ci.yml`                                    | fork CI: jobs gated to `pingdotgg/t3code` — fork has no blacksmith runners, ungated jobs queue forever on every PR                                                                                                         |
| `.github/workflows/release.yml`                               | fork CI: root jobs gated to `pingdotgg/t3code` — the 3-hourly schedule fires on the fork too; downstream cascades                                                                                                          |
| `.github/workflows/deploy-relay.yml`                          | fork CI: job gated to `pingdotgg/t3code` — the fork must never deploy upstream's relay                                                                                                                                     |
| `.github/workflows/mobile-fingerprint-check.yml`              | fork CI: job gated to `pingdotgg/t3code` — its paths match every sync PR                                                                                                                                                   |
| `apps/server/src/persistence/Layers/Sqlite.ts`                | migrator registration: one `yield* runNomiorMigrations()` after upstream's `runMigrations()` in the shared sqlite `setup` layer — Nomior schema never enters upstream's `migrationEntries`                                 |
| `apps/server/package.json`                                    | script registration (`nomior:eval-retrieval`, `nomior:seed`, `nomior:simulate`, `nomior:gen-fixtures`) and `googleapis` + `google-auth-library` deps for the Google connectors (loaded through a dynamic-import seam)      |
| `vite.config.ts`                                              | one `fmt.ignorePatterns` entry for `apps/web/src/nomior/fixtures.generated.ts` (the seed generator owns that file's layout and a drift test compares it byte for byte), plus `.claude/worktrees/**` in `fmt`/`lint`/`test` |
| `.gitignore`                                                  | `.claude/worktrees/` — agent worktrees are nested checkouts of this repo; untracked and excluded from the lint/fmt walk                                                                                                    |
| `apps/server/src/mcp/McpHttpServer.ts`                        | toolkit registration: one import plus `Layer.mergeAll(PreviewToolkitRegistrationLive, NomiorContextToolkitRegistrationLive)` in the exported `layer`                                                                       |
| `apps/server/src/server.test.ts`                              | test wiring: `Layer.provide(SqlitePersistenceMemory)` → `provideMerge` so the route layer sees `SqlClient`, which the Nomior MCP context toolkit's retrieval port needs (server.ts already supplies it in production)      |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`           | sidebar entry + footer-page detection for the `/nomior` panels; wordmark is the Nomior Code mark plus `APP_BASE_NAME`, replacing the upstream T3 logo path                                                                 |
| `apps/web/src/routeTree.gen.ts`                               | generated by TanStack Router; regenerated after adding the additive `/nomior` route files                                                                                                                                  |
| `packages/contracts/src/rpc.ts`                               | the eleven `nomior.*` RPC methods: `WS_METHODS` entries, `Rpc.make` declarations, `WsRpcGroup` members                                                                                                                     |
| `packages/contracts/src/index.ts`                             | re-export of the additive `nomior.ts` contract module                                                                                                                                                                      |
| `apps/server/src/auth/RpcAuthorization.ts`                    | required auth scope per `nomior.*` RPC method; the registry is exhaustive by type, so a new method cannot skip it                                                                                                          |
| `apps/web/index.html`                                         | branding: static boot-shell title, splash aria-label and logo alt (rendered before React hydrates, so it cannot read `APP_BASE_NAME`)                                                                                      |
| `apps/web/src/branding.logic.ts`                              | branding: `splitBrandLockup`, which splits the base name into the sidebar lockup's two halves                                                                                                                              |

<!-- fork-manifest:end -->

## Branding boundary

Rebranding covers user-visible display strings in the web and desktop clients,
all sourced from `packages/shared/src/nomiorBrand.ts`.
`apps/web/src/nomiorBrandGuard.test.ts` asserts the key display constants and
copy stay free of upstream marks. Deliberately unchanged, so upstream merges
and existing user state keep working:

- npm package names (`@t3tools/*`, `t3`), binary names, CLI command names
- config/state dirs (`~/.t3`, `t3code`, `t3code-dev`, the legacy
  `T3 Code (Alpha)` userData probe), localStorage keys (`t3code:*`)
- app IDs (`com.t3tools.t3code`), Linux wm-class/desktop-entry file names,
  protocol schemes
- protocol-facing identifiers (MCP server name, git author/committer names)
- "T3 Connect" (the relay/tunnel service, tied to upstream's hosted infra) and
  the "T3 Chat" theme label
- code comments mentioning upstream names (not user-visible)

Known-pending (NOT yet rebranded — later tracks own these):

- the mobile app, and web copy that names it
  (`apps/web/src/components/clerk/MobileClientsUserProfilePage.*` — telling
  users to look for "Nomior Code" on a phone that still runs the T3 Code app
  would be wrong until the mobile rebrand lands)
- server CLI strings (`t3 …` output), `relayClient`, `cliAuthHtml`, and web
  diagnostics copy naming the `t3` server process
  (`DiagnosticsSettings.tsx`, `ResourceTelemetryDiagnostics.tsx`)

Each upstream release can add new hardcoded "T3 Code" copy; sweep
`grep -rn "T3 Code" apps/web/src apps/desktop/src` during sync-PR review.

## Lockfile policy

`pnpm-lock.yaml` is marked `merge=binary` in `.gitattributes`: git never
attempts a textual merge, so a sync merge where both sides touched the
lockfile always stops as a conflict. Resolution is mechanical, never manual:
take upstream's lockfile and regenerate ours on top of it —
`scripts/nomior/resolve-lockfile.sh` does exactly that (checkout `--theirs`,
then `pnpm install --lockfile-only`, then `git add`). Never hand-merge lockfile
hunks.

## Sync workflow

`.github/workflows/nomior-upstream-sync.yml` opens a daily PR merging the
newest unmerged upstream stable tag into `sync/upstream-<tag>`, labels it
`upstream-sync`, and lists in the body which manifest'd files the sync
touched. If the open sync branch carries commits not authored by
`nomior-sync-bot` (a human pushed fixes onto the PR), the run leaves the
branch and PR untouched instead of force-pushing over them. Auto-merge stays
off until several clean runs have been observed (PLAN.md, "Fork discipline").
`.github/workflows/nomior-canary.yml` builds daily against upstream's newest
nightly tag for advance warning and gates nothing.

## Upstream workflows on the fork

Upstream workflows target `blacksmith-*` runners this fork does not have; an
ungated job queues forever and blocks "merge once checks are green". The four
that fire on their own (`ci.yml`, `release.yml` via its 3-hourly schedule,
`deploy-relay.yml` on push to main, `mobile-fingerprint-check.yml` whose paths
match every sync PR) are job-gated to `github.repository == 'pingdotgg/t3code'`
(rows above). The preview workflows (`web-preview.yml`,
`desktop-macos-preview.yml`, `mobile-eas-preview.yml`) already skip without
their opt-in labels, and `pr-size.yml` / `pr-vouch.yml` run fine on standard
runners, so they stay untouched. A new upstream workflow arriving in a sync PR
needs the same gate (or a disable in the fork's Actions settings) if it
auto-triggers on blacksmith runners.
