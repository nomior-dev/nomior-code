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

import * as CalendarEventStore from "./connectors/calendar/CalendarEventStore.ts";
import * as ConnectorAccountStore from "./connectors/ConnectorAccountStore.ts";
import * as ConnectorCursorStore from "./connectors/ConnectorCursorStore.ts";
import * as ConnectorSyncRunStore from "./connectors/ConnectorSyncRunStore.ts";
import { ConnectorContextIngestLive } from "./connectors/ContextIngestAdapter.ts";
import * as GoogleClientIdStore from "./connectors/google/GoogleClientIdStore.ts";
import * as GoogleTokenVault from "./connectors/google/GoogleTokenVault.ts";
import { GoogleTokenPortLive } from "./connectors/google/googleapisRuntime.ts";
import { ContextBrokerLive } from "./context/ContextBroker.ts";
import { ContextRetrievalPortLive } from "./context/RetrievalPortLive.ts";
import * as MeetingStore from "./meetings/MeetingStore.ts";
import { MemoryCandidateStoreLive } from "./memory/MemoryCandidateStore.ts";
import { MemoryCandidateSinkLive } from "./memory/ReviewSinkLive.ts";
import { LegLauncher, LegRunnerLive } from "./wiring/LegRunnerLive.ts";
import { ReviewPublisher } from "./review/ReviewPublisher.ts";
import * as ReviewJobStore from "./review/ReviewJobStore.ts";
import * as InstanceScheduler from "./scheduler/InstanceScheduler.ts";
import * as RateLimitObserver from "./scheduler/RateLimitObserver.ts";
import * as SchedulerPreferences from "./scheduler/SchedulerPreferences.ts";

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
  Layer.provideMerge(SchedulerPreferences.layer),
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

/**
 * What the connectors panel writes: cursors and sync history for a manual
 * sync, the client-id and token stores behind Connect and Disconnect.
 *
 * `GoogleClientConfig` is deliberately absent. It carries the operator's OAuth
 * client id, which is a value in a store and is normally unset on first run; a
 * layer that failed to build without one would take down every websocket
 * connection, so the handlers read it per request and provide it locally.
 *
 * Requires `SqlClient` and `ServerSecretStore`.
 */
export const NomiorConnectorRpcLive = Layer.mergeAll(
  ConnectorCursorStore.layer,
  ConnectorSyncRunStore.layer,
  GoogleClientIdStore.layer,
  GoogleTokenVault.layer,
  GoogleTokenPortLive,
);

/**
 * Everything the `/nomior` panels read over RPC, in one layer for `ws.ts` to
 * provide. Requires `SqlClient` and `ServerSecretStore`.
 *
 * Deliberately NOT `NomiorReviewPortsLive`: the board reads and annotates jobs,
 * it never runs a leg or publishes a verdict, so it needs `ReviewJobStore`
 * alone. Pulling in the full review ports would drag `LegRunnerLive` and its
 * `ProviderInstanceRegistry` and `InstanceScheduler` dependencies into every
 * WebSocket connection for no read the panels perform.
 *
 * The calendar, connector-account and meeting stores are here rather than in
 * `NomiorConnectorIngestLive` because the panels read them without any sync
 * running; a connector that never fires still has accounts to list, and
 * `MeetingStore` reads sources a previous sync already ingested.
 */
export const NomiorPanelRpcLive = Layer.mergeAll(
  // The connector-ingest layer rather than the bare context one: a manual sync
  // writes through `ConnectorContextIngest`, and this composition keeps it on
  // the same broker the panels read from instead of forking a second one.
  NomiorConnectorIngestLive,
  NomiorSchedulerLive,
  NomiorConnectorRpcLive,
  ReviewJobStore.layer,
  CalendarEventStore.layer,
  ConnectorAccountStore.layer,
  MeetingStore.layer,
);
