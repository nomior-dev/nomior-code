import { createFileRoute } from "@tanstack/react-router";

import { ScrollArea } from "../components/ui/scroll-area";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { CalendarPanel } from "../nomior/CalendarPanel";

function NomiorCalendarRoute() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer width="expanded">
        <CalendarPanel />
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

export const Route = createFileRoute("/nomior/calendar")({
  component: NomiorCalendarRoute,
});
