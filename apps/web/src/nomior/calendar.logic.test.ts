import { describe, expect, it } from "vite-plus/test";

import {
  accountColor,
  agendaDays,
  eventBlockGeometry,
  eventsForDay,
  groupRecurringSeries,
  startOfWeek,
  weekDays,
} from "./calendar.logic";
import type { CalendarEventItem } from "./types";

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

describe("weekDays", () => {
  it("spans seven consecutive days", () => {
    const days = weekDays(new Date(2026, 7, 24));
    expect(days).toHaveLength(7);
    expect(days[6]?.getDate()).toBe(30);
  });
});

describe("eventsForDay", () => {
  it("filters to the local day and sorts by start", () => {
    const tuesday = new Date(2026, 7, 25);
    const later = event({
      id: "later",
      start: new Date(2026, 7, 25, 16).toISOString(),
      end: new Date(2026, 7, 25, 17).toISOString(),
    });
    const earlier = event({
      id: "earlier",
      start: new Date(2026, 7, 25, 9).toISOString(),
      end: new Date(2026, 7, 25, 10).toISOString(),
    });
    const otherDay = event({
      id: "other",
      start: new Date(2026, 7, 26, 9).toISOString(),
      end: new Date(2026, 7, 26, 10).toISOString(),
    });
    expect(eventsForDay([later, otherDay, earlier], tuesday).map((entry) => entry.id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});

describe("agendaDays", () => {
  it("keeps only days with events", () => {
    const monday = new Date(2026, 7, 24);
    const tuesdayEvent = event({
      start: new Date(2026, 7, 25, 9).toISOString(),
      end: new Date(2026, 7, 25, 10).toISOString(),
    });
    const agenda = agendaDays([tuesdayEvent], monday);
    expect(agenda).toHaveLength(1);
    expect(agenda[0]?.day.getDate()).toBe(25);
  });
});

describe("groupRecurringSeries", () => {
  it("groups by series id, orders occurrences, and skips one-offs", () => {
    const second = event({
      id: "b",
      recurringSeriesId: "s1",
      start: "2026-08-26T09:30:00.000Z",
      end: "2026-08-26T09:45:00.000Z",
    });
    const first = event({
      id: "a",
      recurringSeriesId: "s1",
      start: "2026-08-25T09:30:00.000Z",
      end: "2026-08-25T09:45:00.000Z",
    });
    const oneOff = event({ id: "c" });
    const series = groupRecurringSeries([second, oneOff, first]);
    expect(series).toHaveLength(1);
    expect(series[0]?.occurrences.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("accountColor", () => {
  it("wraps around the palette instead of failing on high indexes", () => {
    expect(accountColor(0)).toEqual(accountColor(4));
    expect(accountColor(7).dot.length).toBeGreaterThan(0);
  });
});

describe("eventBlockGeometry", () => {
  const tuesday = new Date(2026, 7, 25);

  it("places an event proportionally inside the visible hour span", () => {
    const morning = event({
      start: new Date(2026, 7, 25, 10, 0).toISOString(),
      end: new Date(2026, 7, 25, 12, 0).toISOString(),
    });
    const geometry = eventBlockGeometry(morning, tuesday, 8, 20);
    expect(geometry?.topPercent).toBeCloseTo(((10 - 8) / 12) * 100, 5);
    expect(geometry?.heightPercent).toBeCloseTo((2 / 12) * 100, 5);
  });

  it("keeps very short events visible", () => {
    const standup = event({
      start: new Date(2026, 7, 25, 9, 30).toISOString(),
      end: new Date(2026, 7, 25, 9, 45).toISOString(),
    });
    expect(eventBlockGeometry(standup, tuesday, 8, 20)?.heightPercent).toBeGreaterThanOrEqual(2.5);
  });

  it("returns null for an event entirely outside the visible hours", () => {
    const lateNight = event({
      start: new Date(2026, 7, 25, 21, 0).toISOString(),
      end: new Date(2026, 7, 25, 22, 0).toISOString(),
    });
    expect(eventBlockGeometry(lateNight, tuesday, 8, 20)).toBeNull();
  });

  it("clamps an event running past the end of the window to the column edge", () => {
    const evening = event({
      start: new Date(2026, 7, 25, 19, 0).toISOString(),
      end: new Date(2026, 7, 25, 23, 0).toISOString(),
    });
    const geometry = eventBlockGeometry(evening, tuesday, 8, 20);
    expect(geometry?.topPercent).toBeCloseTo(((19 - 8) / 12) * 100, 5);
    expect(geometry?.heightPercent).toBeCloseTo((1 / 12) * 100, 5);
  });

  it("pins a midnight-spanning event to the top of the day it runs into", () => {
    const overnight = event({
      start: new Date(2026, 7, 24, 23, 0).toISOString(),
      end: new Date(2026, 7, 25, 9, 0).toISOString(),
    });
    const geometry = eventBlockGeometry(overnight, tuesday, 8, 20);
    expect(geometry?.topPercent).toBe(0);
    expect(geometry?.heightPercent).toBeCloseTo((1 / 12) * 100, 5);
  });
});
