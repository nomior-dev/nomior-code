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
Anything larger belongs in an additive module.

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
| `apps/web/package.json`                                       | dependency registration: `date-fns` + `@date-fns/tz`, for the vendored event calendar                                                                                                                                      |
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
| `.github/workflows/mobile-eas-production.yml`                 | fork CI: job gated to `pingdotgg/t3code` — pushes to `main` under `apps/mobile`, `packages/contracts` or `packages/client-runtime` fire it, which is most Nomior work                                                      |
| `apps/server/src/cli/service.ts`                              | branding: `t3 service` output uses the `nomiorBrand` constant                                                                                                                                                              |
| `apps/server/src/cli/pair.ts`                                 | branding: `t3 pair` output uses the `nomiorBrand` constant                                                                                                                                                                 |
| `apps/server/src/cli/pair.test.ts`                            | branding: pairing-error assertions use the `nomiorBrand` constant                                                                                                                                                          |
| `apps/mobile/app.config.ts`                                   | branding: one `brandProductName` pass over the exported config renames the product in upstream's own strings, so every line stays upstream-identical — bundle ids, scheme and Expo slug are unaffected                                                             |
| `apps/server/src/bin.test.ts`                                 | branding: the `t3 service` help assertion uses the `nomiorBrand` constant                                                                                                                                                  |
| `assets/dev/app-icon.icon/Assets/text.svg`                    | brand mark: the app icon's glyph layer is Nomior's chevrons-and-dot, not the T3 wordmark                                                                                                                                   |
| `assets/nightly/app-icon.icon/Assets/text.svg`                | brand mark: the app icon's glyph layer is Nomior's chevrons-and-dot, not the T3 wordmark                                                                                                                                   |
| `assets/prod/app-icon.icon/Assets/text.svg`                   | brand mark: the app icon's glyph layer is Nomior's chevrons-and-dot, not the T3 wordmark                                                                                                                                   |
| `apps/server/src/persistence/Layers/Sqlite.ts`                | migrator registration: one `yield* runNomiorMigrations()` after upstream's `runMigrations()` in the shared sqlite `setup` layer — Nomior schema never enters upstream's `migrationEntries`                                 |
| `apps/server/package.json`                                    | script registration (`nomior:eval-retrieval`, `nomior:seed`, `nomior:simulate`, `nomior:gen-fixtures`) and `googleapis` + `google-auth-library` deps for the Google connectors (loaded through a dynamic-import seam)      |
| `vite.config.ts`                                              | one `fmt.ignorePatterns` entry for `apps/web/src/nomior/fixtures.generated.ts` (the seed generator owns that file's layout and a drift test compares it byte for byte), plus `.claude/worktrees/**` in `fmt`/`lint`/`test` |
| `.gitignore`                                                  | `.claude/worktrees/` — agent worktrees are nested checkouts of this repo; untracked and excluded from the lint/fmt walk                                                                                                    |
| `apps/server/src/mcp/McpHttpServer.ts`                        | toolkit registration: one import plus `Layer.mergeAll(PreviewToolkitRegistrationLive, NomiorContextToolkitRegistrationLive)` in the exported `layer`                                                                       |
| `apps/server/src/server.test.ts`                              | test wiring: `Layer.provide(SqlitePersistenceMemory)` → `provideMerge` so the route layer sees `SqlClient`, which the Nomior MCP context toolkit's retrieval port needs (server.ts already supplies it in production)      |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`           | wordmark is the Nomior Code mark plus `APP_BASE_NAME`, replacing the upstream T3 logo path; `/nomior` deliberately excluded from footer-page detection so its surfaces keep the utility row instead of a Back button       |
| `apps/web/src/components/Sidebar.tsx`                         | one `<SidebarNomiorNav />` in the fixed header, below the project rows: the Nomior surfaces are top-level destinations rather than tabs behind one button                                                                  |
| `apps/web/src/components/CommandPalette.tsx`                  | one action per `NOMIOR_PAGES` entry plus Instances and Connectors actions, so every surface reachable from the sidebar is reachable from the palette                                                                       |
| `apps/web/src/components/settings/settingsSearch.ts`          | `/settings/connectors` and `/settings/instances` added to `SettingsPath` and the section labels — both are configuration, so they live with the other configuration                                                        |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`     | the `/settings/connectors` and `/settings/instances` icon entries, keeping the icon record total over `SettingsPath`                                                                                                       |
| `apps/web/src/routeTree.gen.ts`                               | generated by TanStack Router; regenerated after adding the additive `/nomior` and `/settings/connectors` route files                                                                                                       |
| `packages/contracts/src/rpc.ts`                               | the eleven `nomior.*` RPC methods: `WS_METHODS` entries, `Rpc.make` declarations, `WsRpcGroup` members                                                                                                                     |
| `packages/contracts/src/index.ts`                             | re-export of the additive `nomior.ts` contract module                                                                                                                                                                      |
| `apps/server/src/auth/RpcAuthorization.ts`                    | required auth scope per `nomior.*` RPC method; the registry is exhaustive by type, so a new method cannot skip it                                                                                                          |
| `apps/web/index.html`                                         | branding: static boot-shell title, splash aria-label and logo alt (rendered before React hydrates, so it cannot read `APP_BASE_NAME`)                                                                                      |
| `apps/web/src/branding.logic.ts`                              | branding: `splitBrandLockup`, which splits the base name into the sidebar lockup's two halves                                                                                                                              |
| `apps/server/src/ws.ts`                                       | handler registration: `makeNomiorPanelHandlers` spread into `WsRpcGroup.of`, `Layer.provide(NomiorPanelRpcLive)` on the websocket RPC route layer, and `isLocalClientRequest(request)` threaded through `makeWsRpcLayer`   |
| `scripts/package.json`                                        | dev dependency `playwright`, used by the additive `scripts/nomior/record-demo-gifs.ts`                                                                                                                                     |
| `apps/desktop/package.json`                                   | app identity: `productName` is `Nomior Code (Alpha)` — electron-builder derives the bundle name, installer name and default userData dir from it                                                                           |
| `apps/desktop/scripts/electron-launcher.mjs`                  | app identity: dev/prod display names, bundle id `com.nomior.nomiorcode`, URL schemes `nomior` / `nomior-dev`                                                                                                               |
| `apps/desktop/scripts/electron-launcher.test.mjs`             | app identity: launcher bundle-path assertions use the new display name                                                                                                                                                     |
| `apps/desktop/src/electron/ElectronProtocol.ts`               | app identity: renderer URL schemes `nomior` / `nomior-dev` — must stay in lockstep with `DESKTOP_RENDERER_ORIGINS` in `apps/server/src/http.ts`                                                                            |
| `apps/desktop/src/electron/ElectronProtocol.test.ts`          | app identity: scheme registration and CSP assertions use the Nomior schemes                                                                                                                                                |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`             | app identity: app-user-model-id and Linux wm-class assertions                                                                                                                                                              |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`         | app identity: pre-`ready` Linux wm-class `nomior` / `nomior-dev`                                                                                                                                                           |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts`    | app identity: wm-class assertion                                                                                                                                                                                           |
| `apps/desktop/src/app/DesktopClerk.ts`                        | app identity: the single-instance-lock comment names the Nomior productName-derived userData dir                                                                                                                           |
| `apps/desktop/src/app/DesktopClerk.test.ts`                   | app identity: renderer-scheme and userData-dir assertions                                                                                                                                                                  |
| `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`              | app identity: `nomior-url-handler.desktop` — the entry lands in the user's shared applications dir, so the filename must not collide with upstream's                                                                       |
| `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts`         | app identity: entry filename, scheme and display-name assertions                                                                                                                                                           |
| `apps/desktop/src/window/DesktopWindow.test.ts`               | app identity: renderer origin fixtures use `nomior://app`                                                                                                                                                                  |
| `apps/server/src/http.ts`                                     | app identity: `DESKTOP_RENDERER_ORIGINS` — the CORS allowlist for the Electron renderer's custom scheme                                                                                                                    |
| `apps/server/src/cloud/bootService.ts`                        | app identity: systemd unit `nomior.service` and launchd label `com.nomior.nomiorcode.service`                                                                                                                              |
| `apps/server/src/cloud/bootService.test.ts`                   | app identity: unit-path, plist-path and launchctl-argument assertions                                                                                                                                                      |
| `apps/server/src/cli/service.test.ts`                         | app identity: boot-service unit-path fixture                                                                                                                                                                               |
| `apps/web/src/environments/primary/httpLayer.test.ts`         | app identity: desktop renderer origin fixture                                                                                                                                                                              |
| `apps/web/src/cloud/linkEnvironment.test.ts`                  | app identity: desktop renderer origin fixture                                                                                                                                                                              |
| `apps/web/src/components/clerk/authRedirect.test.ts`          | app identity: desktop OAuth redirect-URL fixtures                                                                                                                                                                          |
| `scripts/build-desktop-artifact.ts`                           | app identity: `appId`, `productName`, `artifactName`, mac/linux protocol schemes, Linux `executableName` and `StartupWMClass`                                                                                              |
| `scripts/build-desktop-artifact.test.ts`                      | app identity: packaging-config assertions                                                                                                                                                                                  |
| `scripts/release-smoke.ts`                                    | app identity: update-manifest asset-name fixtures follow `artifactName`                                                                                                                                                    |
| `scripts/merge-update-manifests.test.ts`                      | app identity: update-manifest asset-name fixtures follow `artifactName`                                                                                                                                                    |
| `scripts/dev-runner.test.ts`                                  | app identity: `T3_BOOT_SERVICE_UNIT` fixture follows the renamed boot-service unit                                                                                                                                         |
| `docs/user/background-service.md`                             | docs: systemd unit and launchd plist names users look for                                                                                                                                                                  |
| `docs/internals/t3-connect.md`                                | docs: Clerk redirect allowlist, `allowed_origins`, and the macOS bundle id used for passkeys                                                                                                                               |
| `docs/internals/scripts.md`                                   | docs: desktop production root URL scheme                                                                                                                                                                                   |
| `docs/internals/workspace-layout.md`                          | docs: the protocol the Electron shell loads the web bundle over                                                                                                                                                            |
| `docs/operations/release.md`                                  | docs: macOS App ID and provisioning-profile identifier                                                                                                                                                                     |

<!-- fork-manifest:end -->

## Branding boundary

Rebranding covers user-visible display strings in the web and desktop clients,
all sourced from `packages/shared/src/nomiorBrand.ts`.
`apps/web/src/nomiorBrandGuard.test.ts` asserts the key display constants and
copy stay free of upstream marks. Deliberately unchanged, so upstream merges
and existing user state keep working:

- npm package names (`@t3tools/*`, `t3`), binary names, CLI command names
- the server state dir (`~/.t3`) and localStorage keys (`t3code:*`)
- internal markers invisible outside the app: the worktree branch prefix
  (`t3code/…`), the preview session partition (`persist:t3code-preview-*`),
  the WSL runtime marker files, the Electron user-agent token, and the Grok
  OAuth referrer (`t3code`, allowlisted by xAI upstream)
- protocol-facing identifiers (MCP server name, git author/committer names)
- "T3 Connect" (the relay/tunnel service, tied to upstream's hosted infra) and
  the "T3 Chat" theme label
- code comments mentioning upstream names (not user-visible)

## Desktop app identity

Separate from display branding, and deliberately Nomior's own so a machine can
run both apps without their OAuth callbacks, launchd records or app state
crossing over. These values must move together — the renderer scheme in
`ElectronProtocol.ts` and the CORS allowlist in `apps/server/src/http.ts` in
particular, or every renderer request fails its origin check.

| What                   | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| bundle / app id        | `com.nomior.nomiorcode` (`.dev` suffix in development)    |
| URL scheme             | `nomior` (`nomior-dev` in development)                    |
| productName            | `Nomior Code (Alpha)` / `(Nightly)` / `(Dev)`             |
| artifactName           | `Nomior-Code-${version}-${arch}.${ext}`                   |
| userData dir           | `nomior` / `nomior-dev`                                   |
| Linux executable       | `nomior`                                                  |
| Linux wm-class / entry | `nomior` / `nomior.desktop`, `nomior-url-handler.desktop` |
| boot service           | `nomior.service`, `com.nomior.nomiorcode.service`         |

Mobile bundle ids stay upstream's (`com.t3tools.t3code*`): they are App Store
and Play Store listing identities, and changing one creates a new listing.

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
off until several clean runs have been observed.
`.github/workflows/nomior-canary.yml` builds daily against upstream's newest
nightly tag for advance warning and gates nothing.

Two ways the fork can quietly stop receiving upstream releases, and what says
so. A run that dies — a conflict beyond the lockfile, an expired token, a
runner that never starts — opens or comments on an `upstream-sync-failed`
issue. A sync PR that opens and is never merged is not a failure and would
otherwise be invisible, so once the newest stable tag has been out 7 days and
is still off `main`, the run opens or comments on an `upstream-drift` issue;
landing the tag closes it. Neither gates anything.

## Upstream workflows on the fork

Upstream workflows target `blacksmith-*` runners this fork does not have; an
ungated job queues forever and blocks "merge once checks are green". The five
that fire on their own (`ci.yml`, `release.yml` via its 3-hourly schedule,
`deploy-relay.yml` on push to main, `mobile-fingerprint-check.yml` whose paths
match every sync PR, `mobile-eas-production.yml` on pushes to main under
`apps/mobile`, `packages/contracts` or `packages/client-runtime`) are job-gated
to `github.repository == 'pingdotgg/t3code'` (rows above). The preview
workflows (`web-preview.yml`, `desktop-macos-preview.yml`,
`mobile-eas-preview.yml`) already skip without their opt-in labels,
`mobile-showcase-screenshots.yml` and `publish-aur.yml` only run when dispatched
or called, and `pr-size.yml` / `pr-vouch.yml` / `issue-labels.yml` /
`thread-transfer-report.yml` run fine on standard runners, so they stay
untouched. A new upstream workflow arriving in a sync PR needs the same gate
(or a disable in the fork's Actions settings) if it auto-triggers on blacksmith
runners.

The EAS workflows carry their own fork guard as well: their first step checks
for `EXPO_TOKEN` and every later step skips without it, so even ungated they
could never publish into upstream's Expo project. The gate is about the queued
job, not about a publish.
