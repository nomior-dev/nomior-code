/**
 * Pure logic for the unified calendar panel: week math, per-day layout, and
 * recurring-series grouping over multi-account Google events.
 *
 * @module nomior/calendar.logic
 */
import type { CalendarAccount, CalendarEventItem } from "./types";

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

export function weekDays(weekStart: Date): readonly Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** Events overlapping the given local day, ordered by start. */
export function eventsForDay(
  events: readonly CalendarEventItem[],
  day: Date,
): readonly CalendarEventItem[] {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);
  return events
    .filter((event) => new Date(event.start) < dayEnd && new Date(event.end) > dayStart)
    .toSorted((left, right) => left.start.localeCompare(right.start));
}

export interface AgendaDay {
  readonly day: Date;
  readonly events: readonly CalendarEventItem[];
}

/** Agenda view: only days that have events, in week order. */
export function agendaDays(
  events: readonly CalendarEventItem[],
  weekStart: Date,
): readonly AgendaDay[] {
  return weekDays(weekStart)
    .map((day) => ({ day, events: eventsForDay(events, day) }))
    .filter((entry) => entry.events.length > 0);
}

export interface RecurringSeries {
  readonly seriesId: string;
  readonly title: string;
  readonly occurrences: readonly CalendarEventItem[];
}

/**
 * Groups events by Google's `recurringEventId`. One-off events are not series;
 * a series keeps its occurrences in start order.
 */
export function groupRecurringSeries(
  events: readonly CalendarEventItem[],
): readonly RecurringSeries[] {
  const bySeries = new Map<string, CalendarEventItem[]>();
  for (const event of events) {
    if (event.recurringSeriesId === null) continue;
    const occurrences = bySeries.get(event.recurringSeriesId) ?? [];
    occurrences.push(event);
    bySeries.set(event.recurringSeriesId, occurrences);
  }
  return [...bySeries.entries()].map(([seriesId, occurrences]) => {
    const sorted = occurrences.toSorted((left, right) => left.start.localeCompare(right.start));
    return { seriesId, title: sorted[0]?.title ?? seriesId, occurrences: sorted };
  });
}

/**
 * Account color assignment. Classes are literal so Tailwind sees them; tones
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

export function accountColor(colorIndex: number): { dot: string; block: string } {
  return (
    ACCOUNT_COLOR_CLASSES[colorIndex % ACCOUNT_COLOR_CLASSES.length] ?? ACCOUNT_COLOR_CLASSES[0]!
  );
}

export function accountById(
  accounts: readonly CalendarAccount[],
  accountId: string,
): CalendarAccount | undefined {
  return accounts.find((account) => account.id === accountId);
}

/**
 * Vertical placement of an event inside `day`'s column spanning
 * [startHour, endHour) local time. The event is clamped to that window, so a
 * midnight-spanning event sits at the top of the day it runs into and an event
 * running past `endHour` stops at the column edge. Returns null when the event
 * does not overlap the window at all (the week grid skips it; the agenda view
 * still lists it).
 */
export function eventBlockGeometry(
  event: CalendarEventItem,
  day: Date,
  startHour: number,
  endHour: number,
): { topPercent: number; heightPercent: number } | null {
  const windowStart = new Date(day);
  windowStart.setHours(startHour, 0, 0, 0);
  const windowEnd = new Date(day);
  windowEnd.setHours(endHour, 0, 0, 0);
  const spanMs = windowEnd.getTime() - windowStart.getTime();
  const start = Math.max(new Date(event.start).getTime(), windowStart.getTime());
  const end = Math.min(new Date(event.end).getTime(), windowEnd.getTime());
  if (end <= start) return null;
  const topPercent = ((start - windowStart.getTime()) / spanMs) * 100;
  const rawHeight = ((end - start) / spanMs) * 100;
  const heightPercent = Math.min(100 - topPercent, Math.max(2.5, rawHeight));
  return { topPercent, heightPercent };
}
