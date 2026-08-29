/**
 * The Nomior work surfaces, as one registry.
 *
 * These used to be tabs behind a single sidebar button, which put four daily
 * surfaces two clicks deep and left the sidebar claiming Nomior was one thing.
 * They are top-level destinations now, so the label and icon of each is read by
 * the sidebar nav, the page breadcrumb and the command palette alike — three
 * consumers that must never disagree about what a surface is called.
 *
 * Instances is deliberately absent: it is configuration you set once and
 * consult rarely, so it lives at `/settings/instances` with the other
 * configuration rather than beside the surfaces you open every day.
 *
 * @module nomior/pages
 */
import {
  CalendarIcon,
  LibraryBigIcon,
  MicIcon,
  SquareCheckBigIcon,
  type LucideIcon,
} from "lucide-react";

export interface NomiorPage {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  /** Command-palette phrasing, which reads as an action rather than a place. */
  readonly commandLabel: string;
}

export const NOMIOR_PAGES: ReadonlyArray<NomiorPage> = [
  {
    id: "review",
    label: "Review board",
    path: "/nomior/review",
    icon: SquareCheckBigIcon,
    commandLabel: "Open review board",
  },
  {
    id: "meetings",
    label: "Meetings",
    path: "/nomior/meetings",
    icon: MicIcon,
    commandLabel: "Open meetings",
  },
  {
    id: "calendar",
    label: "Calendar",
    path: "/nomior/calendar",
    icon: CalendarIcon,
    commandLabel: "Open calendar",
  },
  {
    id: "context",
    label: "Context & memory",
    path: "/nomior/context",
    icon: LibraryBigIcon,
    commandLabel: "Search context & memory",
  },
];

/**
 * The page a pathname is inside, or null. Prefix matching, so a future detail
 * route under a surface still highlights its own nav entry.
 */
export const nomiorPageFor = (pathname: string): NomiorPage | null =>
  NOMIOR_PAGES.find((page) => pathname.startsWith(page.path)) ?? null;
