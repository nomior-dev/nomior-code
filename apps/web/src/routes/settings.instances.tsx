import { createFileRoute } from "@tanstack/react-router";

import { InstancesPanel } from "../nomior/InstancesPanel";
import { NomiorPortProvider } from "../nomior/port";
import { useNomiorDataPort } from "../nomior/useDataPort";

/**
 * Instances is configuration — which provider accounts exist and whether the
 * scheduler may suggest one — so it sits with the other configuration rather
 * than beside the surfaces you open every day. It brings its own port because
 * `/settings` is outside the `/nomior` shell that provides one.
 */
function SettingsInstancesRoute() {
  return (
    <NomiorPortProvider value={useNomiorDataPort()}>
      <InstancesPanel />
    </NomiorPortProvider>
  );
}

export const Route = createFileRoute("/settings/instances")({
  component: SettingsInstancesRoute,
});
