import { createFileRoute } from "@tanstack/react-router";

import { ScrollArea } from "../components/ui/scroll-area";
import { ReviewBoardPanel } from "../nomior/ReviewBoardPanel";

function NomiorReviewRoute() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-w-0 flex-col pt-4">
        <ReviewBoardPanel />
      </div>
    </ScrollArea>
  );
}

export const Route = createFileRoute("/nomior/review")({
  component: NomiorReviewRoute,
});
