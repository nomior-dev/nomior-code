import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { ConnectorsPanel } from "../nomior/ConnectorsPanel";
import { NomiorPortProvider } from "../nomior/port";
import { useNomiorDataPort } from "../nomior/useDataPort";

/**
 * Connectors is where an environment stops showing sample data: the Google
 * client id, the accounts signed in against it, and the Anarlog store on that
 * machine. It brings its own port because `/settings` is outside the `/nomior`
 * shell that provides one, and its own scroll container because the settings
 * layout hands each page a fixed-height slot.
 */
function SettingsConnectorsRoute() {
  return (
    <SettingsPageContainer>
      <NomiorPortProvider value={useNomiorDataPort()}>
        <ConnectorsPanel />
      </NomiorPortProvider>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/connectors")({
  component: SettingsConnectorsRoute,
});
