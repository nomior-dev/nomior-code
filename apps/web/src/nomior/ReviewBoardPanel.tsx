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
  severityAccentClass,
  severityChips,
} from "./reviewBoard.logic";
import type { ReviewJob } from "./types";
import { usePortData } from "./usePortData";

/**
 * One job.
 *
 * The title leads because it is the only line that tells two cards apart at a
 * glance; the repo and number are the address you need once you have already
 * chosen one. The stripe down the leading edge is the card's worst finding, so
 * a column of a dozen resolves in one pass instead of a dozen badge reads.
 */
export function ReviewJobCard({
  job,
  onRequestManualReview,
}: {
  job: ReviewJob;
  onRequestManualReview: (jobId: string) => void;
}) {
  const chips = severityChips(job.severityCounts);
  const accent = severityAccentClass(job.severityCounts);
  return (
    <div className="relative isolate flex flex-col gap-2 overflow-hidden rounded-lg border bg-card p-3 ps-3.5 text-card-foreground shadow-xs/5 transition-colors hover:border-ring/48">
      {accent === null ? null : (
        <span aria-hidden className={cn("absolute inset-y-0 start-0 w-0.5", accent)} />
      )}
      <p className="line-clamp-2 text-sm leading-snug font-medium text-balance">
        {job.pullRequestTitle}
      </p>
      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <GitPullRequestIcon className="size-3 shrink-0" />
        <span className="truncate">{job.repo}</span>
        <span className="shrink-0">#{job.pullRequestNumber}</span>
      </div>
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
      <div className="flex items-center gap-2 border-t border-border/60 pt-2">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeLabel(job.updatedAt)}
        </span>
        {canRequestManualReview(job) ? (
          <Button
            className="-my-1 ms-auto"
            onClick={() => onRequestManualReview(job.id)}
            size="xs"
            variant="ghost-muted"
          >
            <UserRoundSearchIcon className="size-3.5" />
            {/* Not "Manual review": that is the badge a requested card wears,
                and a button and a badge reading the same on one card is two
                different things wearing one name. */}
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
    // Each column scrolls on its own under a header that stays put, so a long
    // queue never pushes the other four columns' contents out of reach.
    <div className="flex min-h-0 min-w-0 flex-1 snap-x snap-proximity gap-3 overflow-x-auto px-5 pb-8 sm:px-6">
      {REVIEW_COLUMNS.map((column) => {
        const columnJobs = grouped?.get(column.id) ?? null;
        return (
          <section
            aria-label={column.title}
            className="flex w-72 shrink-0 snap-start flex-col rounded-xl border border-border/60 bg-muted/32"
            key={column.id}
          >
            <header className="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border-b border-border/60 bg-muted/32 px-3 py-2 backdrop-blur-sm">
              <span aria-hidden className={cn("size-1.5 rounded-full", column.dotClass)} />
              <h2 className="text-sm font-medium">{column.title}</h2>
              {columnJobs === null ? null : (
                <span className="ms-auto font-mono text-xs tabular-nums text-muted-foreground">
                  {columnJobs.length}
                </span>
              )}
            </header>
            <div className="flex min-h-32 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {columnJobs === null ? (
                <ReviewColumnSkeleton />
              ) : columnJobs.length === 0 ? (
                <p className="m-auto px-2 text-center text-xs text-muted-foreground/70">
                  Nothing here
                </p>
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
