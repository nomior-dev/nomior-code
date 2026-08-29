/**
 * Pure presentation logic for the review board.
 *
 * @module nomior/reviewBoard.logic
 */
import type { ReviewJob, ReviewJobStatus, ReviewRiskTier, ReviewSeverityCounts } from "./types";

export interface ReviewColumn {
  readonly id: ReviewJobStatus;
  readonly title: string;
}

/** Column order mirrors the review engine's state machine. */
export const REVIEW_COLUMNS: readonly ReviewColumn[] = [
  { id: "queue", title: "Queue" },
  { id: "reviewing", title: "Reviewing" },
  { id: "waiting-external", title: "Waiting external" },
  { id: "approved", title: "Approved" },
  { id: "not-approved", title: "Not approved" },
];

/** Jobs per column, most recently updated first inside each. */
export function groupReviewJobs(
  jobs: readonly ReviewJob[],
): ReadonlyMap<ReviewJobStatus, readonly ReviewJob[]> {
  const grouped = new Map<ReviewJobStatus, ReviewJob[]>(
    REVIEW_COLUMNS.map((column) => [column.id, []]),
  );
  for (const job of jobs) {
    grouped.get(job.status)?.push(job);
  }
  for (const columnJobs of grouped.values()) {
    columnJobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return grouped;
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
export function canRequestManualReview(job: ReviewJob): boolean {
  return !job.manualReviewRequested && (job.status === "queue" || job.status === "reviewing");
}
