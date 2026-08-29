import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { ConnectorsPanel } from "../nomior/ConnectorsPanel";
import { NomiorPortProvider } from "../nomior/port";
import { useNomiorDataPort } from "../nomior/useDataPort";

/**
 * Connectors is where an environment stops showing sample data: the accounts
 * it is signed in as, and what each of them last pulled. It brings its own
 * port because `/settings` is outside the `/nomior` shell that provides one,
 * and its own scroll container because the settings layout hands each page a
 * fixed-height slot.
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
