/**
 * NomiorRuntime — the real Nomior layer graph, in one place.
 *
 * Every Nomior track composes here, and the integration tests under
 * `nomior/integration/` build these exact layers rather than recomposing their
 * own. That is deliberate: a toolkit registered without its port provided is a
 * runtime failure, not a compile error, so the only proof a track is wired is
 * a test that builds the shipped layer.
 *
 * ```
 *                        SqlClient (upstream sqlite + nomior migrations)
 *                                      │
 *   NomiorContextLive ─────────────────┤
 *     ContextBrokerLive                │   ContextIngest, ContextRetrieval,
 *       ├ EmbeddingWorkerLive          │   EmbeddingWorker
 *       ├ EmbeddingModelRegistryDefault│
 *       ├ ContextualPrefixerDeterministic
 *       └ RerankerIdentity
 *     MemoryCandidateStoreLive  ←── ContextIngest (promotion on approve)
 *     ContextRetrievalPortLive  ←── ContextRetrieval + MemoryCandidateStore
 *          │
 *          └──▶ mcp/toolkits/nomior  (context_search/get/decisions/remember)
 *
 *   NomiorConnectorIngestLive ←── ContextIngest
 *          └──▶ ConnectorContextIngest (Anarlog/Gmail/Calendar → broker)
 *
 *   NomiorSchedulerLive ───────────────┤   RateLimitObserver, InstanceScheduler
 *          │
 *   NomiorReviewLive ←── InstanceScheduler + ProviderInstanceRegistry
 *     ReviewJobStore.layer
 *     LegRunnerLive ←── LegLauncher.layerHandOff   (no-op by default)
 *     ReviewPublisher.layerNoop                    (no external posting)
 *     MemoryCandidateSinkLive ←── MemoryCandidateStore
 *     ReviewEngine.layer ←── ReviewEngineConfig + ReviewRunContexts
 * ```
 *
 * @module nomior/NomiorRuntime
 */
import * as Layer from "effect/Layer";

import { ConnectorContextIngestLive } from "./connectors/ContextIngestAdapter.ts";
import { ContextBrokerLive } from "./context/ContextBroker.ts";
import { ContextRetrievalPortLive } from "./context/RetrievalPortLive.ts";
import { MemoryCandidateStoreLive } from "./memory/MemoryCandidateStore.ts";
import { MemoryCandidateSinkLive } from "./memory/ReviewSinkLive.ts";
import { LegLauncher, LegRunnerLive } from "./wiring/LegRunnerLive.ts";
import { ReviewPublisher } from "./review/ReviewPublisher.ts";
import * as ReviewJobStore from "./review/ReviewJobStore.ts";
import * as InstanceScheduler from "./scheduler/InstanceScheduler.ts";
import * as RateLimitObserver from "./scheduler/RateLimitObserver.ts";

/**
 * Context engine + memory candidates + the MCP retrieval port, sharing one
 * broker (one embedding worker fiber, one connection). Requires `SqlClient`.
 *
 * `provideMerge` throughout so the broker services stay visible to callers —
 * the connector adapter and the memory store both need `ContextIngest`, and
 * providing the broker twice would fork a second embedding worker.
 */
export const NomiorContextLive = ContextRetrievalPortLive.pipe(
  Layer.provideMerge(MemoryCandidateStoreLive),
  Layer.provideMerge(ContextBrokerLive),
);

/** Connector → broker ingest, on the shared broker. Requires `SqlClient`. */
export const NomiorConnectorIngestLive = ConnectorContextIngestLive.pipe(
  Layer.provideMerge(NomiorContextLive),
);

/**
 * Advisory instance scheduling. `RateLimitObserver.daemonLayer` is NOT
 * included: it needs `ProviderService` and only makes sense in the running
 * server, where it is composed alongside this layer.
 */
export const NomiorSchedulerLive = InstanceScheduler.layer.pipe(
  Layer.provideMerge(RateLimitObserver.layer),
  Layer.provide(InstanceScheduler.InstanceSchedulerConfig.layerDefault),
);

/**
 * The review engine's ports, at their shipped defaults:
 * - `LegLauncher.layerHandOff` — legs are not launched; jobs park in
 *   `waiting-external` for a human (see `LegRunnerLive`).
 * - `ReviewPublisher.layerNoop` — nothing is posted anywhere. External posting
 *   also needs `allowExternalPosting`, which defaults false.
 * - `MemoryCandidateSinkLive` — findings land in the one candidate store as
 *   pending.
 *
 * Requires `SqlClient`, `InstanceScheduler`, `ProviderInstanceRegistry`, and
 * `MemoryCandidateStore`. `ReviewEngine` itself is not built here: it also
 * needs `ReviewRunContexts` (per-job leg configuration), which is deployment
 * data, so the caller provides that and `ReviewEngine.layer`.
 */
export const NomiorReviewPortsLive = Layer.mergeAll(
  ReviewJobStore.layer,
  LegRunnerLive.pipe(Layer.provide(LegLauncher.layerHandOff)),
  ReviewPublisher.layerNoop,
  MemoryCandidateSinkLive,
);
