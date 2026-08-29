/**
 * Pure logic for the context & memory panel.
 *
 * @module nomior/contextMemory.logic
 */
import type { ContextSourceKind } from "./types";

export function sourceKindLabel(kind: ContextSourceKind): string {
  switch (kind) {
    case "meeting":
      return "Meeting";
    case "decision":
      return "Decision";
    case "memory":
      return "Memory";
    case "document":
      return "Document";
    case "mail":
      return "Email";
    case "event":
      return "Event";
  }
}

/** Source dates arrive as ISO days; render them short and locale-aware. */
export function formatSourceDate(isoDate: string, locale?: string): string {
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}
