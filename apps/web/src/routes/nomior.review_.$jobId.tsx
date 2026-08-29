import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { ReviewJobPanel } from "../nomior/ReviewJobPanel";

/**
 * One review, on its own page rather than nested inside the board: a card's
 * detail is not a pane beside the columns, it is where you go when you have
 * finished scanning them.
 */
function NomiorReviewJobRoute() {
  return (
    <WorkspacePageContainer className="min-h-0 flex-1 pb-6">
      <ReviewJobPanel jobId={Route.useParams().jobId} />
    </WorkspacePageContainer>
  );
}

export const Route = createFileRoute("/nomior/review_/$jobId")({
  component: NomiorReviewJobRoute,
});
