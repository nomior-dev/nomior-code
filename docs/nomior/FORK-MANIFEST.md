# Fork manifest — upstream files Nomior modifies

Every touch of an upstream file is listed here (path + why). Everything
else Nomior ships lives in additive paths (`apps/server/src/nomior/**`,
`apps/server/src/mcp/toolkits/nomior/**`, `apps/web/app/nomior/**`,
`packages/nomior-*`). CI flags a sync PR when a listed file changed
upstream.

| Upstream file              | Why we touch it                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/package.json` | Added `googleapis` + `google-auth-library` dependencies for the Google connectors (loaded via a dynamic-import seam in `src/nomior/connectors/google/googleapisRuntime.ts`). |
