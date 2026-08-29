import { createFileRoute } from "@tanstack/react-router";

import { ReviewBoardPanel } from "../nomior/ReviewBoardPanel";

/**
 * No scroll container: the lanes take the height of the page and scroll inside
 * it, which is what makes a long queue scroll under its own header instead of
 * pushing the four other lanes off the bottom.
 */
function NomiorReviewRoute() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-4">
      <ReviewBoardPanel />
    </div>
  );
}

export const Route = createFileRoute("/nomior/review")({
  component: NomiorReviewRoute,
});
