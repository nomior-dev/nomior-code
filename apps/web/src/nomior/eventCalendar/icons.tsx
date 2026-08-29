/**
 * The two icon components the vendored calendar expects from ReUI's own app.
 *
 * Upstream `IconPlaceholder` names the same glyph across five icon libraries so
 * their docs can swap sets; this app has one, so the shim reads the `lucide`
 * name and ignores the rest rather than making every call site carry an import
 * it does not need. Keeping the upstream prop shape is what lets the vendored
 * files stay byte-identical to the registry apart from their import paths.
 *
 * @module nomior/eventCalendar/icons
 */
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  RepeatIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode, SVGProps } from "react";

import { cn } from "../../lib/utils";

const LUCIDE: Record<string, LucideIcon> = {
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  RepeatIcon,
};

export interface IconPlaceholderProps extends SVGProps<SVGSVGElement> {
  readonly lucide: string;
  /** Accepted and ignored: this app renders lucide. */
  readonly tabler?: string;
  readonly hugeicons?: string;
  readonly phosphor?: string;
  readonly remixicon?: string;
}

export function IconPlaceholder({
  lucide,
  tabler: _tabler,
  hugeicons: _hugeicons,
  phosphor: _phosphor,
  remixicon: _remixicon,
  ...props
}: IconPlaceholderProps) {
  const Icon = LUCIDE[lucide];
  return Icon === undefined ? null : <Icon {...props} />;
}

/** The muted disc an empty state's glyph sits in. */
export function IconStack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
