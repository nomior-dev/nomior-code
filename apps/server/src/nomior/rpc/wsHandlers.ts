/**
 * The Nomior half of the WebSocket RPC handler map.
 *
 * `ws.ts` spreads this object into `WsRpcGroup.of({...})`, which keeps the
 * fork's touch on that upstream file to an import, one service acquisition and
 * one spread. Services are acquired inside each handler rather than hoisted,
 * as the MCP toolkit does, so the handler map itself needs no context.
 *
 * @module nomior/rpc/wsHandlers
 */
import { WS_METHODS, type EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerProvider } from "@t3tools/contracts";
import { ConnectorAccountStore } from "../connectors/ConnectorAccountStore.ts";
import { CalendarEventStore } from "../connectors/calendar/CalendarEventStore.ts";
import { ContextRetrievalPort } from "../context/RetrievalPort.ts";
import { MemoryCandidateStore } from "../memory/MemoryCandidateStore.ts";
import { RateLimitObserver } from "../scheduler/RateLimitObserver.ts";
import { SchedulerPreferences } from "../scheduler/SchedulerPreferences.ts";
import { ReviewJobStore } from "../review/ReviewJobStore.ts";
import * as contextHandlers from "./contextHandlers.ts";
import * as panelHandlers from "./panelHandlers.ts";

export interface NomiorPanelHandlerDeps {
  /**
   * `ws.ts`'s per-connection wrapper: enforces the method's scope and traces
   * it. The scope check is why every Nomior Rpc declares
   * `EnvironmentAuthorizationError` alongside `NomiorRequestError`.
   */
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  /** Provider snapshots live in the upstream registry, not in a Nomior service. */
  readonly listProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
}

export const makeNomiorPanelHandlers = ({
  observeRpcEffect,
  listProviders,
}: NomiorPanelHandlerDeps) => ({
  [WS_METHODS.nomiorReviewJobsList]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorReviewJobsList,
      Effect.gen(function* () {
        return yield* panelHandlers.listReviewJobs(yield* ReviewJobStore);
      }),
    ),

  [WS_METHODS.nomiorReviewRequestManual]: (input: { readonly jobId: string }) =>
    observeRpcEffect(
      WS_METHODS.nomiorReviewRequestManual,
      Effect.gen(function* () {
        return yield* panelHandlers.requestManualReview(yield* ReviewJobStore, input);
      }),
    ),

  [WS_METHODS.nomiorContextSearch]: (input: { readonly query: string }) =>
    observeRpcEffect(WS_METHODS.nomiorContextSearch, contextHandlers.searchContext(input)),

  [WS_METHODS.nomiorMemoryCandidatesList]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorMemoryCandidatesList,
      Effect.gen(function* () {
        return yield* contextHandlers.listMemoryCandidates(yield* MemoryCandidateStore);
      }),
    ),

  [WS_METHODS.nomiorMemoryCandidateResolve]: (input: {
    readonly id: string;
    readonly resolution: "approved" | "rejected";
  }) =>
    observeRpcEffect(
      WS_METHODS.nomiorMemoryCandidateResolve,
      Effect.gen(function* () {
        return yield* contextHandlers.resolveMemoryCandidate(yield* MemoryCandidateStore, input);
      }),
    ),

  [WS_METHODS.nomiorCalendarAccountsList]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorCalendarAccountsList,
      Effect.gen(function* () {
        return yield* panelHandlers.listCalendarAccounts(yield* ConnectorAccountStore);
      }),
    ),

  [WS_METHODS.nomiorCalendarEventsList]: (input: {
    readonly rangeStart: string;
    readonly rangeEnd: string;
  }) =>
    observeRpcEffect(
      WS_METHODS.nomiorCalendarEventsList,
      Effect.gen(function* () {
        return yield* panelHandlers.listCalendarEvents(yield* CalendarEventStore, input);
      }),
    ),

  [WS_METHODS.nomiorInstancesList]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorInstancesList,
      Effect.gen(function* () {
        const snapshots = yield* listProviders;
        const observer = yield* RateLimitObserver;
        const preferences = yield* SchedulerPreferences;
        return yield* panelHandlers.listInstances(snapshots, observer, preferences);
      }),
    ),

  [WS_METHODS.nomiorInstanceSetPinned]: (input: {
    readonly instanceId: string;
    readonly pinned: boolean;
  }) =>
    observeRpcEffect(
      WS_METHODS.nomiorInstanceSetPinned,
      Effect.gen(function* () {
        return yield* panelHandlers.setInstancePinned(yield* SchedulerPreferences, input);
      }),
    ),

  [WS_METHODS.nomiorSchedulerGetState]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorSchedulerGetState,
      Effect.gen(function* () {
        return yield* panelHandlers.getSchedulerState(yield* SchedulerPreferences);
      }),
    ),

  [WS_METHODS.nomiorSchedulerSetAdvisoryMode]: (input: { readonly enabled: boolean }) =>
    observeRpcEffect(
      WS_METHODS.nomiorSchedulerSetAdvisoryMode,
      Effect.gen(function* () {
        return yield* panelHandlers.setAdvisoryMode(yield* SchedulerPreferences, input);
      }),
    ),
});

/** Every Nomior service the handler map above pulls from the layer graph. */
export type NomiorPanelHandlerServices =
  | CalendarEventStore
  | ConnectorAccountStore
  | ContextRetrievalPort
  | MemoryCandidateStore
  | RateLimitObserver
  | ReviewJobStore
  | SchedulerPreferences;
