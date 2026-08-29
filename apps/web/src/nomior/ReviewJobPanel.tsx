/**
 * One review job's own page.
 *
 * The board is a queue you scan; this is the thing you scan it for. Everything
 * the engine knows about a job lives here — risk, verdict, findings, whether a
 * human was asked to look — so a card can stay three lines and a column can
 * stay readable.
 *
 * @module nomior/ReviewJobPanel
 */
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  UserRoundSearchIcon,
} from "lucide-react";
import { useCallback } from "react";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import {
  canRequestManualReview,
  pullRequestStateLabel,
  pullRequestUrl,
  reviewStatusLabel,
  riskTierLabel,
  riskTierTone,
  severityChips,
} from "./reviewBoard.logic";
import type { ReviewJobDetail } from "./types";
import { usePortData } from "./usePortData";

function BackToBoard() {
  return (
    <Link
      className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      to="/nomior/review"
    >
      <ArrowLeftIcon className="size-3.5" />
      Review board
    </Link>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

/** The findings the legs reported, as a tally. The findings themselves live in
 *  the review the publisher posts, not in this database. */
function Findings({ job }: { job: ReviewJobDetail }) {
  const chips = severityChips(job.severityCounts);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Findings</h3>
      {chips.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {job.verdict === null
            ? "No leg has reported yet."
            : "Nothing above informational was found."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.label} variant={chip.tone}>
              {chip.count} {chip.label}
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReviewJobReader({
  job,
  onRequestManualReview,
}: {
  job: ReviewJobDetail;
  onRequestManualReview: () => void;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-3">
        <h2 className="text-xl leading-tight font-semibold text-balance">{job.pullRequestTitle}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <GitPullRequestIcon className="size-3.5 shrink-0" />
            {job.repo} #{job.pullRequestNumber}
          </span>
          {/* A plain anchor rather than a shell call: the desktop window turns a
              blocked _blank into openExternal itself, and in a browser tab this
              is the only one of the two that goes anywhere. */}
          <a
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            href={pullRequestUrl(job)}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ExternalLinkIcon className="size-3.5" />
            Open on GitHub
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{reviewStatusLabel(job.status)}</Badge>
          {job.pullRequestState === "open" ? null : (
            // Why this job is not on the board any more, said where someone
            // following an old link will read it.
            <Badge variant={job.pullRequestState === "merged" ? "info" : "secondary"}>
              {pullRequestStateLabel(job.pullRequestState)}
            </Badge>
          )}
          {/* No verdict badge: a verdict only exists in the two states whose
              own name is that verdict, so it would be the same word twice. */}
          <Badge variant={riskTierTone(job.riskTier)}>{riskTierLabel(job.riskTier)}</Badge>
          {job.manualReviewRequested ? <Badge variant="info">Manual review requested</Badge> : null}
        </div>
      </header>

      <Separator />

      <Findings job={job} />

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Fact label="Last change" value={formatRelativeTimeLabel(job.updatedAt)} />
        <Fact label="Queued" value={formatRelativeTimeLabel(job.createdAt)} />
        <Fact label="Head" value={job.headSha} />
      </dl>

      {canRequestManualReview(job) ? (
        <div>
          <Button onClick={onRequestManualReview} size="sm" variant="outline">
            <UserRoundSearchIcon className="size-3.5" />
            Request manual review
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ReviewJobSkeleton() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Skeleton className="h-7 w-96 rounded" />
      <Skeleton className="h-4 w-64 rounded" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

export function ReviewJobPanel({ jobId }: { jobId: string }) {
  const port = useNomiorPort(fixtureNomiorPort);
  const loadJob = useCallback(() => port.getReviewJob(jobId), [port, jobId]);
  const { data: job, error, reload } = usePortData(loadJob);

  const handleRequestManualReview = useCallback(() => {
    void port.requestManualReview(jobId).then(reload);
  }, [port, jobId, reload]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
      <BackToBoard />
      {error !== null ? (
        <PortErrorState label="Couldn't load this review." onRetry={reload} />
      ) : job === null ? (
        <ReviewJobSkeleton />
      ) : (
        <ReviewJobReader job={job} onRequestManualReview={handleRequestManualReview} />
      )}
    </div>
  );
}
