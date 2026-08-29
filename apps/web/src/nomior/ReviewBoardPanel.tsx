import { GitPullRequestIcon, UserRoundSearchIcon } from "lucide-react";
import { useCallback } from "react";

import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import {
  canRequestManualReview,
  groupReviewJobs,
  REVIEW_COLUMNS,
  riskTierLabel,
  riskTierTone,
  severityChips,
} from "./reviewBoard.logic";
import type { ReviewJob } from "./types";
import { usePortData } from "./usePortData";

export function ReviewJobCard({
  job,
  onRequestManualReview,
}: {
  job: ReviewJob;
  onRequestManualReview: (jobId: string) => void;
}) {
  const chips = severityChips(job.severityCounts);
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs/5">
      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span className="truncate">{job.repo}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <GitPullRequestIcon className="size-3" />#{job.pullRequestNumber}
        </span>
      </div>
      <div className="line-clamp-2 text-sm font-medium">{job.pullRequestTitle}</div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge size="sm" variant={riskTierTone(job.riskTier)}>
          {riskTierLabel(job.riskTier)}
        </Badge>
        {job.verdict !== null ? (
          <Badge size="sm" variant={job.verdict === "approved" ? "success" : "error"}>
            {job.verdict === "approved" ? "Approved" : "Not approved"}
          </Badge>
        ) : null}
        {job.manualReviewRequested ? (
          <Badge size="sm" variant="info">
            Manual review
          </Badge>
        ) : null}
        {chips.map((chip) => (
          <Badge key={chip.label} size="sm" variant={chip.tone}>
            {chip.count} {chip.label}
          </Badge>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeLabel(job.updatedAt)}
        </span>
        {canRequestManualReview(job) ? (
          <Button
            className="ms-auto"
            onClick={() => onRequestManualReview(job.id)}
            size="xs"
            variant="ghost-muted"
          >
            <UserRoundSearchIcon className="size-3.5" />
            Request manual review
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ReviewColumnSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-24 w-full rounded-lg" />
    </div>
  );
}

export function ReviewBoardPanel() {
  const port = useNomiorPort(fixtureNomiorPort);
  const loadJobs = useCallback(() => port.listReviewJobs(), [port]);
  const { data: jobs, error, isPending, reload } = usePortData(loadJobs);

  const handleRequestManualReview = useCallback(
    (jobId: string) => {
      void port.requestManualReview(jobId).then(reload);
    },
    [port, reload],
  );

  if (error !== null) {
    return (
      <div className="px-5 sm:px-6">
        <PortErrorState label="Couldn't load review jobs." onRetry={reload} />
      </div>
    );
  }

  if (!isPending && jobs !== null && jobs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No review jobs</EmptyTitle>
          <EmptyDescription>
            Reviews appear here as the engine picks up labeled pull requests and agent turns.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const grouped = jobs === null ? null : groupReviewJobs(jobs);

  return (
    <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto px-5 pb-8 sm:px-6">
      {REVIEW_COLUMNS.map((column) => {
        const columnJobs = grouped?.get(column.id) ?? null;
        return (
          <section
            aria-label={column.title}
            className="flex w-64 shrink-0 flex-col gap-2"
            key={column.id}
          >
            <header className="flex items-center gap-2 px-1">
              <h2 className="text-sm font-medium">{column.title}</h2>
              {columnJobs !== null ? (
                <Badge size="sm" variant="secondary">
                  {columnJobs.length}
                </Badge>
              ) : null}
            </header>
            <div
              className={cn(
                "flex min-h-32 flex-col gap-2 rounded-xl bg-muted/40 p-2",
                columnJobs !== null && columnJobs.length === 0 && "justify-center",
              )}
            >
              {columnJobs === null ? (
                <ReviewColumnSkeleton />
              ) : columnJobs.length === 0 ? (
                <p className="px-2 text-center text-xs text-muted-foreground">Empty</p>
              ) : (
                columnJobs.map((job) => (
                  <ReviewJobCard
                    job={job}
                    key={job.id}
                    onRequestManualReview={handleRequestManualReview}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
