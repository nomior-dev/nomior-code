import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowDownWideNarrowIcon,
  ChevronDownIcon,
  GitPullRequestIcon,
  ListFilterIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import {
  filterReviewJobs,
  groupReviewJobs,
  isReviewSort,
  projectFilterLabel,
  resolveProjectSelection,
  REVIEW_COLUMNS,
  REVIEW_SORTS,
  reviewProjectOptions,
  toggleProject,
  type ReviewProjectOption,
  type ReviewSortId,
} from "./reviewBoard.logic";
import type { ReviewJob } from "./types";
import { usePortData } from "./usePortData";

/**
 * One job.
 *
 * Three facts: what the pull request is called, which project it is in, and
 * when it last moved. Everything the engine knows — risk, verdict, findings,
 * whether a human was asked to look — is on the job's own page, one click away.
 * A card carrying all of it is a card nobody reads; a column of a dozen has to
 * resolve in one pass.
 *
 * Presentational: the link around it belongs to the board, which is what keeps
 * this renderable — and testable — without a router.
 */
export function ReviewJobCard({ job }: { job: ReviewJob }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs/5 transition-colors group-hover/card:border-ring/48 group-hover/card:bg-accent/40">
      <p className="line-clamp-2 text-sm leading-snug font-medium text-balance">
        {job.pullRequestTitle}
      </p>
      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <GitPullRequestIcon className="size-3 shrink-0" />
        <span className="truncate">{job.repo}</span>
        <span className="shrink-0">#{job.pullRequestNumber}</span>
      </div>
      <span className="text-xs text-muted-foreground/80">
        {formatRelativeTimeLabel(job.updatedAt)}
      </span>
    </div>
  );
}

function ReviewColumnSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-20 w-full rounded-lg" />
    </div>
  );
}

/** The board's one ordering control, over every column at once. */
function ReviewSortSelect({
  className,
  onChange,
  value,
}: {
  className?: string;
  onChange: (sort: ReviewSortId) => void;
  value: ReviewSortId;
}) {
  return (
    <Select
      items={REVIEW_SORTS.map((sort) => ({ label: sort.label, value: sort.id }))}
      onValueChange={(next: string | null) => {
        if (isReviewSort(next)) onChange(next);
      }}
      value={value}
    >
      <SelectTrigger aria-label="Sort cards" className={className} size="xs" variant="ghost">
        <ArrowDownWideNarrowIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {REVIEW_SORTS.map((sort) => (
          <SelectItem key={sort.id} value={sort.id}>
            {sort.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Which projects the board shows.
 *
 * Kept across visits: you open a card, come back, and the two projects you
 * were working through are still the two the board shows.
 */
const PROJECT_FILTER_KEY = "nomior:review-board-projects:v1";
const PROJECT_FILTER_SCHEMA = Schema.Array(Schema.String);
const ALL_PROJECTS: readonly string[] = [];

function ReviewProjectFilter({
  onChange,
  options,
  selected,
}: {
  onChange: (selected: readonly string[]) => void;
  options: readonly ReviewProjectOption[];
  selected: readonly string[];
}) {
  return (
    <Menu>
      <MenuTrigger className="text-muted-foreground" render={<Button size="xs" variant="ghost" />}>
        <ListFilterIcon className="size-3.5" />
        {projectFilterLabel(selected, options)}
        <ChevronDownIcon className="size-3 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuCheckboxItem
          checked={selected.length === 0}
          onCheckedChange={() => onChange(ALL_PROJECTS)}
        >
          All projects
        </MenuCheckboxItem>
        <MenuSeparator />
        {options.map((option) => (
          <MenuCheckboxItem
            checked={selected.includes(option.repo)}
            key={option.repo}
            onCheckedChange={() => onChange(toggleProject(selected, option.repo))}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {option.count}
              </span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function ReviewBoardPanel() {
  const port = useNomiorPort(fixtureNomiorPort);
  const loadJobs = useCallback(() => port.listReviewJobs(), [port]);
  const { data: jobs, error, isPending, reload } = usePortData(loadJobs);
  const [sort, setSort] = useState<ReviewSortId>("recent");
  const [storedProjects, setStoredProjects] = useLocalStorage(
    PROJECT_FILTER_KEY,
    ALL_PROJECTS,
    PROJECT_FILTER_SCHEMA,
  );

  const options = useMemo(() => reviewProjectOptions(jobs ?? []), [jobs]);
  // Drive the control from what the board can actually show, so a stored
  // project whose reviews have all landed leaves the filter quietly.
  const selected = useMemo(
    () => resolveProjectSelection(storedProjects, options),
    [storedProjects, options],
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
          <EmptyTitle>No open reviews</EmptyTitle>
          <EmptyDescription>
            Reviews appear here as the engine picks up labeled pull requests, and leave once the
            pull request merges or closes.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const grouped = jobs === null ? null : groupReviewJobs(filterReviewJobs(jobs, selected), sort);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {/* One project is not a choice, so the filter appears only once there is
          something to choose between. */}
      <div className="flex items-center gap-1 px-5 sm:px-6">
        {options.length > 1 ? (
          <ReviewProjectFilter onChange={setStoredProjects} options={options} selected={selected} />
        ) : null}
        <ReviewSortSelect className="ms-auto" onChange={setSort} value={sort} />
      </div>

      {/* Each column scrolls on its own under a header that stays put, so a long
          queue never pushes the other four columns' contents out of reach. */}
      <div className="flex min-h-0 min-w-0 flex-1 snap-x snap-proximity gap-3 overflow-x-auto px-5 pb-8 sm:px-6">
        {REVIEW_COLUMNS.map((column) => {
          const columnJobs = grouped?.get(column.id) ?? null;
          return (
            <section
              aria-label={column.title}
              className="flex w-72 max-w-96 min-w-72 flex-1 shrink-0 snap-start flex-col rounded-xl border border-border/60 bg-muted/32"
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
                    <Link
                      className="group/card rounded-lg focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      key={job.id}
                      params={{ jobId: job.id }}
                      to="/nomior/review/$jobId"
                    >
                      <ReviewJobCard job={job} />
                    </Link>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
