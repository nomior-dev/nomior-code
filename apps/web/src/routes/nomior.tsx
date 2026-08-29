import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";

import { Badge } from "../components/ui/badge";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { fixtureNomiorPort } from "../nomior/fixtures";
import { useNomiorPort } from "../nomior/port";
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
  { id: "instances", label: "Instances", path: "/nomior/instances" },
] as const;

function NomiorLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = NOMIOR_TABS.find((tab) => location.pathname.startsWith(tab.path));
  const port = useNomiorPort(fixtureNomiorPort);

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
              // Every panel behind this layout reads the same port; nothing on
              // these pages is real until the RPC port replaces the fixture.
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
          <Outlet />
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
