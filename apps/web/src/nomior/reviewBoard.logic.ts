/**
 * Pure presentation logic for the review board.
 *
 * @module nomior/reviewBoard.logic
 */
import type {
  ReviewJob,
  ReviewJobDetail,
  ReviewJobStatus,
  ReviewPullRequestState,
  ReviewRiskTier,
  ReviewSeverityCounts,
} from "./types";

export interface ReviewColumn {
  readonly id: ReviewJobStatus;
  readonly title: string;
  /**
   * The colour of the column's marker dot. Position already says where a card
   * is in the run; the dot says whether that position is fine, in progress, or
   * something to look at, which is the thing you scan a board for.
   */
  readonly dotClass: string;
}

/** Column order mirrors the review engine's state machine. */
export const REVIEW_COLUMNS: readonly ReviewColumn[] = [
  { id: "queue", title: "Queue", dotClass: "bg-muted-foreground/40" },
  { id: "reviewing", title: "Reviewing", dotClass: "bg-info" },
  { id: "waiting-external", title: "Waiting external", dotClass: "bg-warning" },
  { id: "approved", title: "Approved", dotClass: "bg-success" },
  { id: "not-approved", title: "Not approved", dotClass: "bg-destructive" },
];

/** What the board calls a status, for pages that show one without its column. */
export function reviewStatusLabel(status: ReviewJobStatus): string {
  return REVIEW_COLUMNS.find((column) => column.id === status)?.title ?? status;
}

/**
 * How the cards inside every column are ordered.
 *
 * One order for the whole board, not one per column: the columns are stages of
 * the same queue, and a board where each column sorts differently cannot be
 * read across.
 */
export const REVIEW_SORTS = [
  { id: "recent", label: "Recently updated" },
  { id: "oldest", label: "Oldest first" },
  { id: "project", label: "Project" },
] as const;

export type ReviewSortId = (typeof REVIEW_SORTS)[number]["id"];

export function isReviewSort(value: string | null): value is ReviewSortId {
  return REVIEW_SORTS.some((sort) => sort.id === value);
}

export function reviewSortLabel(id: ReviewSortId): string {
  return REVIEW_SORTS.find((sort) => sort.id === id)?.label ?? id;
}

const REVIEW_COMPARATORS: Record<ReviewSortId, (left: ReviewJob, right: ReviewJob) => number> = {
  recent: (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  oldest: (left, right) => left.updatedAt.localeCompare(right.updatedAt),
  // Within a project, by pull request number: that is the order the numbers
  // themselves imply, and it puts a project's cards in one run.
  project: (left, right) =>
    left.repo.localeCompare(right.repo) || left.pullRequestNumber - right.pullRequestNumber,
};

export function sortReviewJobs(
  jobs: readonly ReviewJob[],
  sort: ReviewSortId,
): readonly ReviewJob[] {
  return [...jobs].sort(REVIEW_COMPARATORS[sort]);
}

/** Jobs per column, each column in the board's chosen order. */
export function groupReviewJobs(
  jobs: readonly ReviewJob[],
  sort: ReviewSortId = "recent",
): ReadonlyMap<ReviewJobStatus, readonly ReviewJob[]> {
  const grouped = new Map<ReviewJobStatus, ReviewJob[]>(
    REVIEW_COLUMNS.map((column) => [column.id, []]),
  );
  for (const job of jobs) {
    grouped.get(job.status)?.push(job);
  }
  for (const columnJobs of grouped.values()) {
    columnJobs.sort(REVIEW_COMPARATORS[sort]);
  }
  return grouped;
}

export interface ReviewProjectOption {
  readonly repo: string;
  /** What the filter calls the project. */
  readonly label: string;
  /** Open reviews in it, so the menu says what picking it is worth. */
  readonly count: number;
}

/**
 * The projects the board is currently showing, with their card counts.
 *
 * Derived from the jobs rather than from the list of connected repositories: a
 * filter that offers a project with nothing in it is a filter that can empty
 * the board.
 *
 * The owner is dropped — every card shows the same one — unless two projects
 * share a name, and then both keep theirs rather than reading as one project
 * twice.
 */
export function reviewProjectOptions(jobs: readonly ReviewJob[]): readonly ReviewProjectOption[] {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.repo, (counts.get(job.repo) ?? 0) + 1);

  const shortNames = new Map<string, number>();
  for (const repo of counts.keys()) {
    const short = shortProjectName(repo);
    shortNames.set(short, (shortNames.get(short) ?? 0) + 1);
  }

  return [...counts]
    .map(([repo, count]) => {
      const short = shortProjectName(repo);
      return { repo, label: (shortNames.get(short) ?? 0) > 1 ? repo : short, count };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function shortProjectName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1) || repo;
}

/**
 * The selection the board can actually act on.
 *
 * A stored selection outlives the cards it named: pick two projects, let their
 * pull requests merge, and the stored repos are gone from the board. Dropping
 * what is no longer there — and treating what is left of nothing as "all" —
 * is what keeps the board from going blank behind a filter nobody can see.
 */
export function resolveProjectSelection(
  selected: readonly string[],
  options: readonly ReviewProjectOption[],
): readonly string[] {
  const available = new Set(options.map((option) => option.repo));
  return selected.filter((repo) => available.has(repo));
}

/** An empty selection is every project, which is also the board's default. */
export function filterReviewJobs(
  jobs: readonly ReviewJob[],
  selected: readonly string[],
): readonly ReviewJob[] {
  if (selected.length === 0) return jobs;
  const chosen = new Set(selected);
  return jobs.filter((job) => chosen.has(job.repo));
}

export function toggleProject(selected: readonly string[], repo: string): readonly string[] {
  return selected.includes(repo) ? selected.filter((entry) => entry !== repo) : [...selected, repo];
}

/** What the filter's own control says it is doing. */
export function projectFilterLabel(
  selected: readonly string[],
  options: readonly ReviewProjectOption[],
): string {
  if (selected.length === 0) return "All projects";
  if (selected.length === 1) {
    const only = options.find((option) => option.repo === selected[0]);
    if (only !== undefined) return only.label;
  }
  return `${selected.length} projects`;
}

/**
 * The pull request on the forge.
 *
 * A job carries `owner/name` and a number and no host: every repo the engine
 * reviews today is on GitHub. The day one is not, this is the one place that
 * has to learn about it.
 */
export function pullRequestUrl(job: {
  readonly repo: string;
  readonly pullRequestNumber: number;
}): string {
  return `https://github.com/${job.repo}/pull/${job.pullRequestNumber}`;
}

export function pullRequestStateLabel(state: ReviewPullRequestState): string {
  switch (state) {
    case "open":
      return "Open";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
  }
}

export type BadgeTone = "success" | "warning" | "error" | "info" | "secondary" | "outline";

export interface SeverityChip {
  readonly label: string;
  readonly count: number;
  readonly tone: BadgeTone;
}

/** Non-zero severities only; a clean card shows no chips, not three zeros. */
export function severityChips(counts: ReviewSeverityCounts): readonly SeverityChip[] {
  const chips: SeverityChip[] = [];
  if (counts.blocker > 0) chips.push({ label: "blocker", count: counts.blocker, tone: "error" });
  if (counts.major > 0) chips.push({ label: "major", count: counts.major, tone: "warning" });
  if (counts.minor > 0) chips.push({ label: "minor", count: counts.minor, tone: "secondary" });
  return chips;
}

export function riskTierTone(tier: ReviewRiskTier): BadgeTone {
  switch (tier) {
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "secondary";
  }
}

export function riskTierLabel(tier: ReviewRiskTier): string {
  switch (tier) {
    case "high":
      return "High risk";
    case "medium":
      return "Medium risk";
    case "low":
      return "Low risk";
  }
}

/**
 * Manual review can be requested while the auto-review still owns the card:
 * queued or in-flight jobs, once only.
 */
export function canRequestManualReview(job: ReviewJobDetail): boolean {
  return !job.manualReviewRequested && (job.status === "queue" || job.status === "reviewing");
}
