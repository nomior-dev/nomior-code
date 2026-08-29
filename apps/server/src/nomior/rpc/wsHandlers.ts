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
import { ConnectorCursorStore } from "../connectors/ConnectorCursorStore.ts";
import { ConnectorSyncRunStore } from "../connectors/ConnectorSyncRunStore.ts";
import { CalendarEventStore } from "../connectors/calendar/CalendarEventStore.ts";
import { GoogleClientIdStore } from "../connectors/google/GoogleClientIdStore.ts";
import { GoogleTokenVault } from "../connectors/google/GoogleTokenVault.ts";
import { GoogleTokenPort } from "../connectors/google/GooglePorts.ts";
import { ContextRetrievalPort } from "../context/RetrievalPort.ts";
import { MeetingStore } from "../meetings/MeetingStore.ts";
import { MemoryCandidateStore } from "../memory/MemoryCandidateStore.ts";
import { RateLimitObserver } from "../scheduler/RateLimitObserver.ts";
import { SchedulerPreferences } from "../scheduler/SchedulerPreferences.ts";
import { ReviewJobStore } from "../review/ReviewJobStore.ts";
import * as connectorHandlers from "./connectorHandlers.ts";
import * as contextHandlers from "./contextHandlers.ts";
import * as meetingHandlers from "./meetingHandlers.ts";
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
  /**
   * Whether this connection's client runs on the server's own machine. Fixed
   * for the life of the socket, because the peer it was opened from is. Only
   * the connectors panel reads it: Google's loopback redirect lands on the
   * server's host, so a remote client can never complete the flow.
   */
  readonly canStartLocalOAuth: boolean;
}

export const makeNomiorPanelHandlers = ({
  observeRpcEffect,
  listProviders,
  canStartLocalOAuth,
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

  [WS_METHODS.nomiorMeetingsList]: (input: {
    readonly rangeStart?: string | undefined;
    readonly rangeEnd?: string | undefined;
  }) =>
    observeRpcEffect(
      WS_METHODS.nomiorMeetingsList,
      Effect.gen(function* () {
        return yield* meetingHandlers.listMeetings(yield* MeetingStore, input);
      }),
    ),

  [WS_METHODS.nomiorMeetingGet]: (input: { readonly meetingId: string }) =>
    observeRpcEffect(
      WS_METHODS.nomiorMeetingGet,
      Effect.gen(function* () {
        return yield* meetingHandlers.getMeeting(yield* MeetingStore, input);
      }),
    ),

  [WS_METHODS.nomiorConnectorsList]: () =>
    observeRpcEffect(
      WS_METHODS.nomiorConnectorsList,
      Effect.gen(function* () {
        return yield* connectorHandlers.listConnectors({
          accounts: yield* ConnectorAccountStore,
          syncRuns: yield* ConnectorSyncRunStore,
          clientIds: yield* GoogleClientIdStore,
          canStartLocalOAuth,
        });
      }),
    ),

  [WS_METHODS.nomiorGoogleClientIdSet]: (input: { readonly clientId: string }) =>
    observeRpcEffect(
      WS_METHODS.nomiorGoogleClientIdSet,
      Effect.gen(function* () {
        return yield* connectorHandlers.setGoogleClientId(yield* GoogleClientIdStore, input);
      }),
      // Deliberately no trace attribute: the value is the one thing that must
      // not be recorded anywhere.
    ),

  [WS_METHODS.nomiorConnectorConnect]: (input: {
    readonly kind: "googleCalendar" | "gmail" | "anarlog";
  }) =>
    observeRpcEffect(
      WS_METHODS.nomiorConnectorConnect,
      Effect.gen(function* () {
        return yield* connectorHandlers.connectConnector(
          {
            accounts: yield* ConnectorAccountStore,
            clientIds: yield* GoogleClientIdStore,
            canStartLocalOAuth,
          },
          input,
        );
      }),
      { "nomior.connector.kind": input.kind },
    ),

  [WS_METHODS.nomiorConnectorDisconnect]: (input: { readonly accountId: string }) =>
    observeRpcEffect(
      WS_METHODS.nomiorConnectorDisconnect,
      Effect.gen(function* () {
        return yield* connectorHandlers.disconnectConnector(
          {
            accounts: yield* ConnectorAccountStore,
            cursors: yield* ConnectorCursorStore,
            syncRuns: yield* ConnectorSyncRunStore,
            vault: yield* GoogleTokenVault,
          },
          input,
        );
      }),
    ),

  [WS_METHODS.nomiorConnectorSync]: (input: { readonly accountId: string }) =>
    observeRpcEffect(
      WS_METHODS.nomiorConnectorSync,
      Effect.gen(function* () {
        return yield* connectorHandlers.syncConnector(
          {
            accounts: yield* ConnectorAccountStore,
            clientIds: yield* GoogleClientIdStore,
          },
          input,
        );
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
  | ConnectorCursorStore
  | ConnectorSyncRunStore
  | ContextRetrievalPort
  | GoogleClientIdStore
  | GoogleTokenPort
  | GoogleTokenVault
  | MeetingStore
  | MemoryCandidateStore
  | RateLimitObserver
  | ReviewJobStore
  | SchedulerPreferences;
