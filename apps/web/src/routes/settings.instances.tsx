import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { InstancesPanel } from "../nomior/InstancesPanel";
import { NomiorPortProvider } from "../nomior/port";
import { useNomiorDataPort } from "../nomior/useDataPort";

/**
 * Instances is configuration — which provider accounts exist and whether the
 * scheduler may suggest one — so it sits with the other configuration rather
 * than beside the surfaces you open every day. It brings its own port because
 * `/settings` is outside the `/nomior` shell that provides one, and its own
 * scroll container because the settings layout hands each page a fixed-height
 * slot: without it a long instance list is clipped with no way to reach the end.
 */
function SettingsInstancesRoute() {
  return (
    <SettingsPageContainer>
      <NomiorPortProvider value={useNomiorDataPort()}>
        <InstancesPanel />
      </NomiorPortProvider>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/instances")({
  component: SettingsInstancesRoute,
});
