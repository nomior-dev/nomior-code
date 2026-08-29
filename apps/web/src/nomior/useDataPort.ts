/**
 * The Nomior data port for whichever environment is primary.
 *
 * Lives here rather than in the `/nomior` route because Instances renders under
 * `/settings` now, and a panel must get the same port wherever it is mounted.
 *
 * @module nomior/useDataPort
 */
import { RegistryContext } from "@effect/atom-react";
import { useContext, useMemo } from "react";

import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { createNomiorCommandRunner } from "../state/nomior";
import { fixtureNomiorPort } from "./fixtures";
import type { NomiorDataPort } from "./port";
import { createRpcNomiorPort, whileConnecting } from "./rpcPort";

/**
 * The live port whenever there is an environment to talk to, the fixture port
 * otherwise (hosted app.t3.codes with nothing paired). An environment that is
 * registered but offline still gets the live port: its panels then show the
 * real failure with a retry, rather than swapping to sample data unannounced.
 * While the socket is still coming up the reads are held pending instead, so a
 * fresh load shows a skeleton rather than an error it is about to disprove.
 */
export function useNomiorDataPort(): NomiorDataPort {
  const registry = useContext(RegistryContext);
  const environmentId = usePrimaryEnvironmentId();
  const phase = usePrimaryEnvironment()?.connection.phase ?? "available";

  return useMemo(() => {
    if (environmentId === null) return fixtureNomiorPort();
    const live = createRpcNomiorPort(createNomiorCommandRunner(registry, environmentId));
    return phase === "connecting" || phase === "reconnecting" ? whileConnecting(live) : live;
  }, [environmentId, phase, registry]);
}
