import { createFileRoute } from "@tanstack/react-router";

import { ScrollArea } from "../components/ui/scroll-area";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { InstancesPanel } from "../nomior/InstancesPanel";

function NomiorInstancesRoute() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer width="wide">
        <InstancesPanel />
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

export const Route = createFileRoute("/nomior/instances")({
  component: NomiorInstancesRoute,
});
