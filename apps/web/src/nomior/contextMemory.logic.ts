/**
 * Pure logic for the context & memory panel.
 *
 * @module nomior/contextMemory.logic
 */
import type { ContextSourceKind, MemoryCandidate, MemoryCandidateResolution } from "./types";

export function sourceKindLabel(kind: ContextSourceKind): string {
  switch (kind) {
    case "meeting":
      return "Meeting";
    case "document":
      return "Document";
    case "thread":
      return "Thread";
    case "review":
      return "Review";
  }
}

/** Source dates arrive as ISO days; render them short and locale-aware. */
export function formatSourceDate(isoDate: string, locale?: string): string {
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Candidates keep board order but resolved ones sink below pending ones, so
 * the queue of decisions stays on top without rows vanishing on click.
 */
export function orderMemoryCandidates(
  candidates: readonly MemoryCandidate[],
): readonly MemoryCandidate[] {
  const pending = candidates.filter((candidate) => candidate.status === "pending");
  const resolved = candidates.filter((candidate) => candidate.status !== "pending");
  return [...pending, ...resolved];
}

export function applyCandidateResolution(
  candidates: readonly MemoryCandidate[],
  id: string,
  resolution: MemoryCandidateResolution,
): readonly MemoryCandidate[] {
  return candidates.map((candidate) =>
    candidate.id === id ? { ...candidate, status: resolution } : candidate,
  );
}

export function pendingCandidateCount(candidates: readonly MemoryCandidate[]): number {
  return candidates.filter((candidate) => candidate.status === "pending").length;
}
