import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { Badge } from "../components/ui/badge";
import { SidebarInset } from "../components/ui/sidebar";
import { NomiorPortProvider } from "../nomior/port";
import { nomiorPageFor } from "../nomior/pages";
import { useNomiorDataPort } from "../nomior/useDataPort";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/**
 * The shell the Nomior surfaces render inside: one data port for all of them,
 * and the header that names the current one.
 *
 * There is no tab bar. Every surface this shell hosts is its own sidebar entry,
 * so a strip repeating those four choices would be a second navigation for the
 * same destinations — and the one that disagrees first when a surface is added.
 */
function NomiorLayout() {
  const location = useLocation();
  const page = nomiorPageFor(location.pathname);
  const port = useNomiorDataPort();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Nomior breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">{page?.label ?? "Nomior"}</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {port.isFixture ? (
              // Every panel behind this layout reads the port provided below,
              // so one badge covers the whole surface.
              <Badge className="shrink-0" size="sm" variant="warning">
                Sample data
              </Badge>
            ) : null}
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
