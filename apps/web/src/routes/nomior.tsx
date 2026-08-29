import { RegistryContext } from "@effect/atom-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useContext, useMemo } from "react";

import { Badge } from "../components/ui/badge";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { fixtureNomiorPort } from "../nomior/fixtures";
import { type NomiorDataPort, NomiorPortProvider } from "../nomior/port";
import { createRpcNomiorPort, whileConnecting } from "../nomior/rpcPort";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { createNomiorCommandRunner } from "../state/nomior";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

const NOMIOR_TABS = [
  { id: "review", label: "Review board", path: "/nomior/review" },
  { id: "context", label: "Context & memory", path: "/nomior/context" },
  { id: "calendar", label: "Calendar", path: "/nomior/calendar" },
  { id: "meetings", label: "Meetings", path: "/nomior/meetings" },
  { id: "instances", label: "Instances", path: "/nomior/instances" },
] as const;

/**
 * The live port whenever there is an environment to talk to, the fixture port
 * otherwise (hosted app.t3.codes with nothing paired). An environment that is
 * registered but offline still gets the live port: its panels then show the
 * real failure with a retry, rather than swapping to sample data unannounced.
 * While the socket is still coming up the reads are held pending instead, so a
 * fresh load shows a skeleton rather than an error it is about to disprove.
 */
function useNomiorDataPort(): NomiorDataPort {
  const registry = useContext(RegistryContext);
  const environmentId = usePrimaryEnvironmentId();
  const phase = usePrimaryEnvironment()?.connection.phase ?? "available";

  return useMemo(() => {
    if (environmentId === null) return fixtureNomiorPort();
    const live = createRpcNomiorPort(createNomiorCommandRunner(registry, environmentId));
    return phase === "connecting" || phase === "reconnecting" ? whileConnecting(live) : live;
  }, [environmentId, phase, registry]);
}

function NomiorLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = NOMIOR_TABS.find((tab) => location.pathname.startsWith(tab.path));
  const port = useNomiorDataPort();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Nomior breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem>
                <h1>Nomior</h1>
              </WorkspaceBreadcrumbItem>
              {activeTab ? (
                <>
                  <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
                  <WorkspaceBreadcrumbItem className="hidden md:flex" current>
                    <span className="truncate">{activeTab.label}</span>
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
            {port.isFixture ? (
              // Every panel behind this layout reads the port provided below,
              // so one badge covers the whole surface.
              <Badge className="shrink-0" size="sm" variant="warning">
                Sample data
              </Badge>
            ) : null}
            <div className="ms-auto flex min-w-0 items-center justify-end">
              <ToggleGroup
                aria-label="Nomior panels"
                onValueChange={(next) => {
                  const target = NOMIOR_TABS.find((tab) => tab.id === next[0]);
                  if (target) void navigate({ to: target.path });
                }}
                value={activeTab ? [activeTab.id] : []}
                variant="segmented"
              >
                {NOMIOR_TABS.map((tab) => (
                  <Toggle key={tab.id} value={tab.id}>
                    {tab.label}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <NomiorPortProvider value={port}>
            <Outlet />
          </NomiorPortProvider>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/nomior")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/nomior") {
      throw redirect({ to: "/nomior/review", replace: true });
    }
  },
  component: NomiorLayout,
});
