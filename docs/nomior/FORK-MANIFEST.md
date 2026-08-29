# Nomior fork manifest — upstream files we modify

One entry per upstream file we touch, with the one-line reason. CI flags a sync
PR whenever a file listed here changed upstream. Everything else Nomior ships
is additive (`apps/server/src/nomior/**`, `apps/server/src/mcp/toolkits/nomior/**`,
`packages/nomior-*`, `resources/nomior-skill/**`).

| Upstream file                          | Why we touch it                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/mcp/McpHttpServer.ts` | Registers the Nomior context toolkit beside the preview toolkit: one import plus `Layer.mergeAll(PreviewToolkitRegistrationLive, NomiorContextToolkitRegistrationLive)` in the exported `layer`. |
