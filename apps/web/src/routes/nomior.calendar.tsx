import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { Skeleton } from "../components/ui/skeleton";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";

/**
 * Loaded on demand. The calendar grid is the largest component in the app by
 * some distance, and routes here are not code-split, so a static import would
 * put every kilobyte of it in the bundle that every other page waits for.
 */
const CalendarPanel = lazy(async () => ({
  default: (await import("../nomior/CalendarPanel")).CalendarPanel,
}));

/**
 * No scroll container: unlike the other Nomior pages this one does not grow
 * down the page. The grid takes the height it is given and scrolls its own
 * time axis inside it, so a wrapper that scrolls would scroll the header away
 * from the grid it belongs to.
 *
 * It takes the width it is given too. A reading measure is what caps the other
 * pages, and a week has no measure — capping it just narrows seven columns and
 * spends the rest of a wide display on margin.
 */
function NomiorCalendarRoute() {
  return (
    <WorkspacePageContainer className="min-h-0 max-w-none flex-1 pb-6">
      <Suspense fallback={<Skeleton className="min-h-0 flex-1 rounded-xl" />}>
        <CalendarPanel />
      </Suspense>
    </WorkspacePageContainer>
  );
}

export const Route = createFileRoute("/nomior/calendar")({
  component: NomiorCalendarRoute,
});
