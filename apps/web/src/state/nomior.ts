import { createNomiorEnvironmentCommands } from "@t3tools/client-runtime/state/nomior";
import { type AtomCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import type { NomiorCommandRunner } from "../nomior/rpcPort";

export const nomiorEnvironment = createNomiorEnvironmentCommands(connectionAtomRuntime);

export function createNomiorCommandRunner(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): NomiorCommandRunner {
  const run = <Input, A>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      A,
      unknown
    >,
    input: Input,
  ) => runAtomCommand(registry, command, { environmentId, input });

  return {
    listReviewJobs: () => run(nomiorEnvironment.listReviewJobs, undefined),
    getReviewJob: (input) => run(nomiorEnvironment.getReviewJob, input),
    requestManualReview: (input) => run(nomiorEnvironment.requestManualReview, input),
    listProjects: () => run(nomiorEnvironment.listProjects, undefined),
    searchContext: (input) => run(nomiorEnvironment.searchContext, input),
    listMeetings: () => run(nomiorEnvironment.listMeetings, {}),
    getMeeting: (input) => run(nomiorEnvironment.getMeeting, input),
    listConnectors: () => run(nomiorEnvironment.listConnectors, undefined),
    setGoogleClientId: (input) => run(nomiorEnvironment.setGoogleClientId, input),
    connectConnector: (input) => run(nomiorEnvironment.connectConnector, input),
    disconnectConnector: (input) => run(nomiorEnvironment.disconnectConnector, input),
    syncConnector: (input) => run(nomiorEnvironment.syncConnector, input),
    listCalendarAccounts: () => run(nomiorEnvironment.listCalendarAccounts, undefined),
    listCalendarEvents: (input) => run(nomiorEnvironment.listCalendarEvents, input),
    listInstances: () => run(nomiorEnvironment.listInstances, undefined),
    setInstancePinned: (input) => run(nomiorEnvironment.setInstancePinned, input),
    getSchedulerState: () => run(nomiorEnvironment.getSchedulerState, undefined),
    setAdvisoryMode: (input) => run(nomiorEnvironment.setAdvisoryMode, input),
  };
}
