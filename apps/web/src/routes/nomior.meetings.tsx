import { createFileRoute } from "@tanstack/react-router";

import { ScrollArea } from "../components/ui/scroll-area";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { MeetingsPanel } from "../nomior/MeetingsPanel";

function NomiorMeetingsRoute() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer width="expanded">
        <MeetingsPanel />
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

export const Route = createFileRoute("/nomior/meetings")({
  component: NomiorMeetingsRoute,
});
