import { describe, expect, it } from "vite-plus/test";

import {
  accountColor,
  accountEventColor,
  AGENDA_DAY_COUNT,
  calendarRangeLabel,
  calendarStepLabel,
  calendarViewLabel,
  CALENDAR_VIEWS,
  eventsForAccounts,
  isCalendarView,
  shiftCalendarDate,
  startOfWeek,
  toCalendarEvents,
  toCalendarResources,
  visibleAccounts,
} from "./calendar.logic";
import type { CalendarAccount, CalendarEventItem } from "./types";

const event = (overrides: Partial<CalendarEventItem>): CalendarEventItem => ({
  id: "evt-1",
  accountId: "acct-1",
  title: "Event",
  start: "2026-08-25T10:00:00.000Z",
  end: "2026-08-25T11:00:00.000Z",
  recurringSeriesId: null,
  meeting: null,
  ...overrides,
});

const account = (id: string, colorIndex: number): CalendarAccount => ({
  id,
  email: `${id}@example.com`,
  colorIndex,
});

describe("startOfWeek", () => {
  it("returns the Monday of the containing week at local midnight", () => {
    // 2026-08-29 is a Saturday.
    const monday = startOfWeek(new Date(2026, 7, 29, 15, 30));
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(24);
    expect(monday.getHours()).toBe(0);
  });

  it("is idempotent on a Monday", () => {
    const monday = startOfWeek(new Date(2026, 7, 24, 0, 0));
    expect(monday.getDate()).toBe(24);
  });
});

describe("views", () => {
  it("names every view it offers, and recognises only those", () => {
    for (const view of CALENDAR_VIEWS) {
      expect(calendarViewLabel(view).length).toBeGreaterThan(0);
      expect(isCalendarView(view)).toBe(true);
    }
    expect(isCalendarView("days")).toBe(false);
    expect(isCalendarView(undefined)).toBe(false);
  });

  it("calls the resource view what it actually shows here", () => {
    // Accounts are the only dimension; "Resource" would name nothing.
    expect(calendarViewLabel("resource")).toBe("By account");
  });

  it("labels the arrows by what they move, not by the view's name", () => {
    expect(calendarStepLabel("month")).toBe("month");
    expect(calendarStepLabel("week")).toBe("week");
    expect(calendarStepLabel("agenda")).toBe(`${AGENDA_DAY_COUNT} days`);
    expect(calendarStepLabel("day")).toBe("day");
    expect(calendarStepLabel("resource")).toBe("day");
  });
});

describe("stepping the date", () => {
  it("steps a month, a day, or a week, by view", () => {
    const august = new Date(2026, 7, 15);
    expect(shiftCalendarDate(august, "month", 1).getMonth()).toBe(8);
    expect(shiftCalendarDate(august, "month", -1).getMonth()).toBe(6);
    expect(shiftCalendarDate(august, "day", 1).getDate()).toBe(16);
    expect(shiftCalendarDate(august, "week", 1).getDate()).toBe(22);
    // The by-account view columns one day by account, so it steps a day.
    expect(shiftCalendarDate(august, "resource", -1).getDate()).toBe(14);
  });

  it("does not skip February when stepping off a 31st", () => {
    const january31 = new Date(2027, 0, 31);
    expect(shiftCalendarDate(january31, "month", 1).getMonth()).toBe(1);
  });
});

describe("range label", () => {
  it("says what the view is actually showing", () => {
    const date = new Date(2026, 7, 26);
    expect(calendarRangeLabel(date, "month")).toContain("2026");
    expect(calendarRangeLabel(date, "day")).toContain("26");
    // Same grid, one day, so the same label: the by-account view splits that
    // day into account columns rather than adding days.
    expect(calendarRangeLabel(date, "resource")).toBe(calendarRangeLabel(date, "day"));
    // A week label spans its own Monday to Sunday, not the clicked day.
    const week = calendarRangeLabel(date, "week");
    expect(week).toContain("24");
    expect(week).toContain("30");
  });

  it("runs the agenda label forward from the day, not from Monday", () => {
    // The agenda lists AGENDA_DAY_COUNT days starting where you are; snapping
    // its label to a week would name days the list does not contain.
    const label = calendarRangeLabel(new Date(2026, 7, 26), "agenda");
    expect(label).toContain("26");
    expect(label).toContain("Sep");
    expect(shiftCalendarDate(new Date(2026, 7, 26), "agenda", 1).getDate()).toBe(25);
  });
});

describe("account colours", () => {
  it("gives the legend and the events the same hue, and wraps past the palette", () => {
    expect(accountColor(0).dot).toContain("sky");
    expect(accountEventColor(0)).toContain("sky");
    expect(accountEventColor(4)).toBe(accountEventColor(0));
    expect(accountColor(4).dot).toBe(accountColor(0).dot);
  });
});

describe("calendar events", () => {
  const accounts = [account("acct-1", 0), account("acct-2", 1)];

  it("carries the account, its colour and the meeting artifacts through", () => {
    const [mapped] = toCalendarEvents(
      [event({ meeting: { meetingId: "m1", hasTranscript: true, hasNotes: false } })],
      accounts,
    );
    expect(mapped?.resourceId).toBe("acct-1");
    expect(mapped?.color).toBe(accountEventColor(0));
    expect(mapped?.data.accountEmail).toBe("acct-1@example.com");
    expect(mapped?.data.meeting?.hasTranscript).toBe(true);
  });

  it("marks every event read-only: nothing here writes back to Google", () => {
    const mapped = toCalendarEvents([event({}), event({ id: "evt-2" })], accounts);
    expect(mapped.every((entry) => entry.readOnly)).toBe(true);
  });

  it("carries a series id only when the event has one", () => {
    const [oneOff] = toCalendarEvents([event({})], accounts);
    const [recurring] = toCalendarEvents([event({ recurringSeriesId: "series-1" })], accounts);
    expect(oneOff?.recurringEventId).toBeUndefined();
    expect(recurring?.recurringEventId).toBe("series-1");
  });

  it("still renders an event whose account is not in the list", () => {
    // A sync can land an event before the account list is re-read; dropping it
    // would show an emptier day than the one the user has.
    const [orphan] = toCalendarEvents([event({ accountId: "acct-9" })], accounts);
    expect(orphan?.data.accountEmail).toBe("acct-9");
    expect(orphan?.color).toBe(accountEventColor(0));
  });
});

describe("account filter", () => {
  const accounts = [account("acct-1", 0), account("acct-2", 1)];

  it("keeps the accounts that are not hidden", () => {
    const shown = visibleAccounts(accounts, new Set(["acct-1"]));
    expect(shown.map((entry) => entry.id)).toEqual(["acct-2"]);
    expect(eventsForAccounts([event({}), event({ accountId: "acct-2" })], shown)).toHaveLength(1);
  });

  it("treats hiding everything as hiding nothing", () => {
    // An empty grid cannot say whether the week is free or the filter ate it.
    const shown = visibleAccounts(accounts, new Set(["acct-1", "acct-2"]));
    expect(shown).toHaveLength(2);
  });

  it("shows an account connected after the filter was set", () => {
    const withNew = [...accounts, account("acct-3", 2)];
    expect(visibleAccounts(withNew, new Set(["acct-1"])).map((entry) => entry.id)).toEqual([
      "acct-2",
      "acct-3",
    ]);
  });

  it("columns the by-account view on exactly the accounts still showing", () => {
    const shown = visibleAccounts(accounts, new Set(["acct-2"]));
    expect(toCalendarResources(shown)).toEqual([
      { id: "acct-1", title: "acct-1@example.com", color: accountEventColor(0) },
    ]);
  });
});
