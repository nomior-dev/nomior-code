/**
 * RPC-backed Nomior data port.
 *
 * `NomiorCommandRunner` is the seam that keeps this module out of the
 * connection runtime: it hands back settled command results, and turning a
 * failure into a rejection — carrying the server's own message, so the panels'
 * error states say something true — is this module's job.
 *
 * @module nomior/rpcPort
 */
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  NomiorCalendarAccountsListResult,
  NomiorCalendarEventsListInput,
  NomiorCalendarEventsListResult,
  NomiorContextSearchInput,
  NomiorContextSearchResult,
  NomiorInstanceSetPinnedInput,
  NomiorInstancesListResult,
  NomiorMemoryCandidateResolveInput,
  NomiorMeetingDetail,
  NomiorMeetingGetInput,
  NomiorMeetingsListResult,
  NomiorConnectorAccountInput,
  NomiorConnectorConnectInput,
  NomiorConnectorConnectResult,
  NomiorConnectorsListResult,
  NomiorConnectorSyncResult,
  NomiorGoogleClientIdSetInput,
  NomiorMemoryCandidatesListResult,
  NomiorReviewJobsListResult,
  NomiorReviewRequestManualInput,
  NomiorSchedulerState,
  NomiorSetAdvisoryModeInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import type { NomiorDataPort } from "./port";

type Settled<A> = Promise<AtomCommandResult<A, unknown>>;

/** One method per Nomior RPC, already bound to an environment. */
export interface NomiorCommandRunner {
  readonly listReviewJobs: () => Settled<NomiorReviewJobsListResult>;
  readonly requestManualReview: (input: NomiorReviewRequestManualInput) => Settled<void>;
  readonly searchContext: (input: NomiorContextSearchInput) => Settled<NomiorContextSearchResult>;
  readonly listMeetings: () => Settled<NomiorMeetingsListResult>;
  readonly getMeeting: (input: NomiorMeetingGetInput) => Settled<NomiorMeetingDetail>;
  readonly listConnectors: () => Settled<NomiorConnectorsListResult>;
  readonly setGoogleClientId: (input: NomiorGoogleClientIdSetInput) => Settled<void>;
  readonly connectConnector: (
    input: NomiorConnectorConnectInput,
  ) => Settled<NomiorConnectorConnectResult>;
  readonly disconnectConnector: (input: NomiorConnectorAccountInput) => Settled<void>;
  readonly syncConnector: (
    input: NomiorConnectorAccountInput,
  ) => Settled<NomiorConnectorSyncResult>;
  readonly listMemoryCandidates: () => Settled<NomiorMemoryCandidatesListResult>;
  readonly resolveMemoryCandidate: (input: NomiorMemoryCandidateResolveInput) => Settled<void>;
  readonly listCalendarAccounts: () => Settled<NomiorCalendarAccountsListResult>;
  readonly listCalendarEvents: (
    input: NomiorCalendarEventsListInput,
  ) => Settled<NomiorCalendarEventsListResult>;
  readonly listInstances: () => Settled<NomiorInstancesListResult>;
  readonly setInstancePinned: (input: NomiorInstanceSetPinnedInput) => Settled<void>;
  readonly getSchedulerState: () => Settled<NomiorSchedulerState>;
  readonly setAdvisoryMode: (input: NomiorSetAdvisoryModeInput) => Settled<void>;
}

export function formatNomiorPortError(cause: Cause.Cause<unknown>): Error {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure
    : new Error("The Nomior request failed.");
}

/**
 * Resolving empty data on a failed command would read as "nothing to show", so
 * a failure rejects and the panels render their error state instead.
 */
async function value<A>(settled: Settled<A>): Promise<A> {
  const result = await settled;
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw formatNomiorPortError(result.cause);
}

export function createRpcNomiorPort(runner: NomiorCommandRunner): NomiorDataPort {
  return {
    isFixture: false,

    listReviewJobs: async () => (await value(runner.listReviewJobs())).jobs,
    requestManualReview: async (jobId) => {
      await value(runner.requestManualReview({ jobId }));
    },

    searchContext: async (query) => (await value(runner.searchContext({ query }))).snippets,
    // No wire method opens a snippet's source: the contract carries retrieval
    // only, so this stays the no-op the fixture already is.
    openContextSource: () => Promise.resolve(),
    listMeetings: async () => (await value(runner.listMeetings())).meetings,
    getMeeting: (meetingId) => value(runner.getMeeting({ meetingId })),
    listConnectors: () => value(runner.listConnectors()),
    setGoogleClientId: async (clientId) => {
      await value(runner.setGoogleClientId({ clientId }));
    },
    connectConnector: async (kind) =>
      (await value(runner.connectConnector({ kind }))).authorizationUrl,
    disconnectConnector: async (accountId) => {
      await value(runner.disconnectConnector({ accountId }));
    },
    syncConnector: async (accountId) => (await value(runner.syncConnector({ accountId }))).ingested,
    listMemoryCandidates: async () => (await value(runner.listMemoryCandidates())).candidates,
    resolveMemoryCandidate: async (id, resolution) => {
      await value(runner.resolveMemoryCandidate({ id, resolution }));
    },

    listCalendarAccounts: async () => (await value(runner.listCalendarAccounts())).accounts,
    listCalendarEvents: async (rangeStart, rangeEnd) =>
      (await value(runner.listCalendarEvents({ rangeStart, rangeEnd }))).events,

    listInstances: async () => (await value(runner.listInstances())).instances,
    setInstancePinned: async (id, pinned) => {
      await value(runner.setInstancePinned({ instanceId: id, pinned }));
    },
    getSchedulerState: () => value(runner.getSchedulerState()),
    setAdvisoryMode: async (enabled) => {
      await value(runner.setAdvisoryMode({ enabled }));
    },
  };
}

/** A promise that never settles: the caller's effect is cancelled on unmount. */
const never = <A>(): Promise<A> => new Promise<A>(() => {});

/**
 * The live port with its reads held open while the socket is still coming up.
 *
 * A read issued during `connecting` or `reconnecting` would otherwise fail with
 * "not connected" and leave the panel showing an error for a connection that is
 * about to succeed — a lie on every fresh page load. Holding the read pending
 * keeps the panel on its skeleton until the phase resolves; the route swaps
 * this wrapper for the bare port the moment it does, which re-fires the read.
 *
 * Writes are not wrapped: they are user-initiated, only reachable from a panel
 * that already loaded, and a real failure is the honest answer for a click.
 */
export function whileConnecting(port: NomiorDataPort): NomiorDataPort {
  return {
    ...port,
    listReviewJobs: never,
    searchContext: never,
    listMeetings: never,
    getMeeting: never,
    listConnectors: never,
    listMemoryCandidates: never,
    listCalendarAccounts: never,
    listCalendarEvents: never,
    listInstances: never,
    getSchedulerState: never,
  };
}
