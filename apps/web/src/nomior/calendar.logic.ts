/**
 * Pure logic for the calendar panel: the mapping from Nomior's events and
 * connected accounts onto the vendored event calendar's model, plus the header
 * arithmetic that model does not own.
 *
 * The grid itself — day columns, overlap packing, all-day lanes — belongs to
 * `./eventCalendar`. What stays here is everything specific to this product:
 * one colour per connected account, the account an event belongs to, and
 * whether a slot already has a transcript or notes behind it.
 *
 * @module nomior/calendar.logic
 */
import type { CalendarAccount, CalendarEventItem } from "./types";

/**
 * The views the panel offers, in the order they appear.
 *
 * `resource` is the by-account view. Accounts are the only dimension this
 * product groups a calendar by — there is no personal-versus-work split, only
 * which Google account an event came from — so the resource columns are the
 * connected accounts and nothing else ever populates them.
 */
export const CALENDAR_VIEWS = ["month", "week", "day", "agenda", "resource"] as const;

export type CalendarViewId = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: string | undefined): value is CalendarViewId {
  return value !== undefined && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

export function calendarViewLabel(view: CalendarViewId): string {
  switch (view) {
    case "month":
      return "Month";
    case "week":
      return "Week";
    case "day":
      return "Day";
    case "agenda":
      return "Agenda";
    case "resource":
      return "By account";
  }
}

/** Monday 00:00 local time of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  const weekday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - weekday);
  return monday;
}

export function addDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

/**
 * One step of whatever the current view shows. Month steps a month, the
 * day-shaped views step a day, and everything else steps a week — the
 * by-account view included, since its columns are accounts and its rows are
 * one week's worth of time.
 */
export function shiftCalendarDate(date: Date, view: CalendarViewId, direction: 1 | -1): Date {
  if (view === "month") {
    const shifted = new Date(date);
    // Anchor to the 1st first: stepping from the 31st would otherwise skip a
    // short month entirely.
    shifted.setDate(1);
    shifted.setMonth(shifted.getMonth() + direction);
    return shifted;
  }
  return addDays(date, (view === "day" ? 1 : 7) * direction);
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** What the header says the grid is showing. */
export function calendarRangeLabel(date: Date, view: CalendarViewId): string {
  if (view === "month") {
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (view === "day") {
    return date.toLocaleDateString(undefined, { weekday: "long", ...MONTH_DAY });
  }
  const start = startOfWeek(date);
  const end = addDays(start, 6);
  return `${start.toLocaleDateString(undefined, MONTH_DAY)} – ${end.toLocaleDateString(
    undefined,
    MONTH_DAY,
  )}`;
}

/**
 * Account colour assignment. Classes are literal so Tailwind sees them; tones
 * hold up on both light and dark surfaces.
 */
const ACCOUNT_COLOR_CLASSES: readonly { dot: string; block: string }[] = [
  { dot: "bg-sky-500", block: "border-sky-500/50 bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  {
    dot: "bg-amber-500",
    block: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  {
    dot: "bg-violet-500",
    block: "border-violet-500/50 bg-violet-500/12 text-violet-700 dark:text-violet-300",
  },
  {
    dot: "bg-emerald-500",
    block: "border-emerald-500/50 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
];

/**
 * The same four hues as a colour value rather than a class.
 *
 * The calendar tints an event through a `--ec-event-color` custom property, so
 * it needs a colour and not a utility class. These read Tailwind's own theme
 * variables, which is what keeps a legend dot and its events the same colour
 * without two palettes drifting apart.
 */
const ACCOUNT_EVENT_COLORS: readonly string[] = [
  "var(--color-sky-500)",
  "var(--color-amber-500)",
  "var(--color-violet-500)",
  "var(--color-emerald-500)",
];

export function accountColor(colorIndex: number): { dot: string; block: string } {
  return (
    ACCOUNT_COLOR_CLASSES[colorIndex % ACCOUNT_COLOR_CLASSES.length] ?? ACCOUNT_COLOR_CLASSES[0]!
  );
}

export function accountEventColor(colorIndex: number): string {
  return ACCOUNT_EVENT_COLORS[colorIndex % ACCOUNT_EVENT_COLORS.length] ?? ACCOUNT_EVENT_COLORS[0]!;
}

export function accountById(
  accounts: readonly CalendarAccount[],
  accountId: string,
): CalendarAccount | undefined {
  return accounts.find((account) => account.id === accountId);
}

/** What a rendered event carries beyond title and time. */
export interface NomiorEventData {
  readonly accountId: string;
  readonly accountEmail: string;
  readonly meeting: CalendarEventItem["meeting"];
}

/** The shape the vendored calendar consumes. Structural, so it stays local. */
export interface CalendarEventInput {
  readonly id: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly color: string;
  readonly resourceId: string;
  readonly readOnly: true;
  readonly recurringEventId?: string;
  readonly data: NomiorEventData;
}

/**
 * Nomior's events in the calendar's model.
 *
 * Every event is `readOnly`: these come from Google and nothing here writes
 * back, so an event that could be dragged to a new time would be lying about
 * what happens next. `resourceId` is the account, which is what the by-account
 * view columns on.
 */
export function toCalendarEvents(
  events: readonly CalendarEventItem[],
  accounts: readonly CalendarAccount[],
): CalendarEventInput[] {
  return events.map((event) => {
    const account = accountById(accounts, event.accountId);
    return {
      id: event.id,
      title: event.title,
      start: new Date(event.start),
      end: new Date(event.end),
      color: accountEventColor(account?.colorIndex ?? 0),
      resourceId: event.accountId,
      readOnly: true,
      ...(event.recurringSeriesId === null ? {} : { recurringEventId: event.recurringSeriesId }),
      data: {
        accountId: event.accountId,
        accountEmail: account?.email ?? event.accountId,
        meeting: event.meeting,
      },
    } satisfies CalendarEventInput;
  });
}

export interface CalendarResourceInput {
  readonly id: string;
  readonly title: string;
  readonly color: string;
}

/** One column per connected account, in the order the legend lists them. */
export function toCalendarResources(accounts: readonly CalendarAccount[]): CalendarResourceInput[] {
  return accounts.map((account) => ({
    id: account.id,
    title: account.email,
    color: accountEventColor(account.colorIndex),
  }));
}

/**
 * The accounts a filter leaves showing.
 *
 * Hiding is stored rather than showing, so an account connected while the page
 * is open appears instead of being silently filtered out by a set that predates
 * it. Hiding every account is treated as hiding none: an empty calendar with no
 * way to tell "nothing scheduled" from "you filtered it all out" is worse than
 * ignoring the last toggle.
 */
export function visibleAccounts(
  accounts: readonly CalendarAccount[],
  hiddenAccountIds: ReadonlySet<string>,
): readonly CalendarAccount[] {
  const visible = accounts.filter((account) => !hiddenAccountIds.has(account.id));
  return visible.length === 0 ? accounts : visible;
}

export function eventsForAccounts(
  events: readonly CalendarEventItem[],
  visible: readonly CalendarAccount[],
): readonly CalendarEventItem[] {
  const ids = new Set(visible.map((account) => account.id));
  return events.filter((event) => ids.has(event.accountId));
}
