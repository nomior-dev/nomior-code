import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Nomior panel RPC calls, reads included.
 *
 * Reads are commands rather than query atoms because the panels consume a
 * Promise-based data port outside React state: nothing mounts an atom on their
 * behalf, so every call has to be runnable on demand.
 */
export function createNomiorEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listReviewJobs: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:review-jobs-list",
      tag: WS_METHODS.nomiorReviewJobsList,
    }),
    requestManualReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:review-request-manual",
      tag: WS_METHODS.nomiorReviewRequestManual,
    }),
    searchContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:context-search",
      tag: WS_METHODS.nomiorContextSearch,
    }),
    listMeetings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:meetings-list",
      tag: WS_METHODS.nomiorMeetingsList,
    }),
    getMeeting: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:meeting-get",
      tag: WS_METHODS.nomiorMeetingGet,
    }),
    listMemoryCandidates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:memory-candidates-list",
      tag: WS_METHODS.nomiorMemoryCandidatesList,
    }),
    resolveMemoryCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:memory-candidate-resolve",
      tag: WS_METHODS.nomiorMemoryCandidateResolve,
    }),
    listCalendarAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:calendar-accounts-list",
      tag: WS_METHODS.nomiorCalendarAccountsList,
    }),
    listCalendarEvents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:calendar-events-list",
      tag: WS_METHODS.nomiorCalendarEventsList,
    }),
    listInstances: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:instances-list",
      tag: WS_METHODS.nomiorInstancesList,
    }),
    setInstancePinned: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:instance-set-pinned",
      tag: WS_METHODS.nomiorInstanceSetPinned,
    }),
    getSchedulerState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:scheduler-get-state",
      tag: WS_METHODS.nomiorSchedulerGetState,
    }),
    setAdvisoryMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:nomior:scheduler-set-advisory-mode",
      tag: WS_METHODS.nomiorSchedulerSetAdvisoryMode,
    }),
  };
}
