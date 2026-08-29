import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { MeetingsPanel } from "../nomior/MeetingsPanel";

/**
 * The list and the meeting are two panes, so the page is their frame rather
 * than a column they sit in: it takes the width and the height, and each pane
 * scrolls itself. Scrolling the page instead would carry the meeting you are
 * reading off the top while you look down the list for the next one.
 */
function NomiorMeetingsRoute() {
  return (
    <WorkspacePageContainer className="min-h-0 max-w-none flex-1 pb-6">
      <MeetingsPanel />
    </WorkspacePageContainer>
  );
}

export const Route = createFileRoute("/nomior/meetings")({
  component: NomiorMeetingsRoute,
});
