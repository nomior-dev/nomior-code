import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon, MicIcon, RepeatIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  accountById,
  accountColor,
  addDays,
  agendaDays,
  eventBlockGeometry,
  eventsForDay,
  groupRecurringSeries,
  isSameDay,
  startOfWeek,
  weekDays,
} from "./calendar.logic";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { CalendarAccount, CalendarEventItem } from "./types";
import { usePortData } from "./usePortData";

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const HOURS = Array.from(
  { length: DAY_END_HOUR - DAY_START_HOUR },
  (_, index) => DAY_START_HOUR + index,
);

type CalendarViewMode = "week" | "agenda";

function formatTimeRange(event: CalendarEventItem): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return `${new Date(event.start).toLocaleTimeString(undefined, options)} – ${new Date(
    event.end,
  ).toLocaleTimeString(undefined, options)}`;
}

function MeetingArtifactChips({ event }: { event: CalendarEventItem }) {
  if (event.meeting === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {event.meeting.hasTranscript ? (
        <MicIcon aria-label="Transcript linked" className="size-3 opacity-70" />
      ) : null}
      {event.meeting.hasNotes ? (
        <FileTextIcon aria-label="Notes linked" className="size-3 opacity-70" />
      ) : null}
    </span>
  );
}

function AccountLegend({ accounts }: { accounts: readonly CalendarAccount[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {accounts.map((account) => (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" key={account.id}>
          <span className={cn("size-2 rounded-full", accountColor(account.colorIndex).dot)} />
          {account.email}
        </span>
      ))}
    </div>
  );
}

export function WeekGrid({
  accounts,
  events,
  weekStart,
  today,
}: {
  accounts: readonly CalendarAccount[];
  events: readonly CalendarEventItem[];
  weekStart: Date;
  today: Date;
}) {
  const days = weekDays(weekStart);
  return (
    <div className="min-w-[640px]">
      <div className="grid grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]">
        <div />
        {days.map((day) => (
          <div
            className={cn(
              "border-b border-border px-1 pb-1 text-center text-xs",
              isSameDay(day, today) ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
            key={day.toISOString()}
          >
            {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]">
        <div className="relative h-[36rem]">
          {HOURS.map((hour) => (
            <span
              className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground"
              key={hour}
              style={{ top: `${((hour - DAY_START_HOUR) / HOURS.length) * 100}%` }}
            >
              {hour}:00
            </span>
          ))}
        </div>
        {days.map((day) => {
          const dayEvents = eventsForDay(events, day);
          return (
            <div
              className={cn(
                "relative h-[36rem] overflow-hidden border-l border-border",
                isSameDay(day, today) && "bg-accent/30",
              )}
              key={day.toISOString()}
            >
              {HOURS.slice(1).map((hour) => (
                <div
                  aria-hidden
                  className="absolute inset-x-0 border-t border-border/50"
                  key={hour}
                  style={{ top: `${((hour - DAY_START_HOUR) / HOURS.length) * 100}%` }}
                />
              ))}
              {dayEvents.map((event) => {
                const geometry = eventBlockGeometry(event, day, DAY_START_HOUR, DAY_END_HOUR);
                if (geometry === null) return null;
                const account = accountById(accounts, event.accountId);
                const color = accountColor(account?.colorIndex ?? 0);
                return (
                  <Tooltip key={event.id}>
                    <TooltipTrigger
                      render={
                        <div
                          className={cn(
                            "absolute inset-x-0.5 flex min-w-0 items-start gap-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] leading-tight",
                            color.block,
                          )}
                          style={{
                            top: `${geometry.topPercent}%`,
                            height: `${geometry.heightPercent}%`,
                          }}
                        >
                          <span className="truncate font-medium">{event.title}</span>
                          {event.recurringSeriesId !== null ? (
                            <RepeatIcon className="mt-px size-3 shrink-0 opacity-70" />
                          ) : null}
                          <MeetingArtifactChips event={event} />
                        </div>
                      }
                    />
                    <TooltipPopup side="top">
                      {event.title} · {formatTimeRange(event)}
                      {account ? ` · ${account.email}` : ""}
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgendaList({
  accounts,
  events,
  weekStart,
}: {
  accounts: readonly CalendarAccount[];
  events: readonly CalendarEventItem[];
  weekStart: Date;
}) {
  const days = agendaDays(events, weekStart);
  if (days.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No events this week.</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      {days.map(({ day, events: dayEvents }) => (
        <section aria-label={day.toDateString()} key={day.toISOString()}>
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            {day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </h3>
          <div className="mt-1 flex flex-col divide-y divide-border">
            {dayEvents.map((event) => {
              const account = accountById(accounts, event.accountId);
              const color = accountColor(account?.colorIndex ?? 0);
              return (
                <div className="flex min-w-0 items-center gap-3 py-2" key={event.id}>
                  <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                    {formatTimeRange(event)}
                  </span>
                  <span className={cn("size-2 shrink-0 rounded-full", color.dot)} />
                  <span className="truncate text-sm font-medium">{event.title}</span>
                  {event.recurringSeriesId !== null ? (
                    <RepeatIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  {event.meeting !== null ? (
                    <span className="flex shrink-0 items-center gap-1">
                      {event.meeting.hasTranscript ? (
                        <Badge size="sm" variant="secondary">
                          <MicIcon />
                          Transcript
                        </Badge>
                      ) : null}
                      {event.meeting.hasNotes ? (
                        <Badge size="sm" variant="secondary">
                          <FileTextIcon />
                          Notes
                        </Badge>
                      ) : null}
                    </span>
                  ) : null}
                  <span className="ms-auto hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {account?.email}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function RecurringSeriesSection({ events }: { events: readonly CalendarEventItem[] }) {
  const series = groupRecurringSeries(events);
  if (series.length === 0) return null;
  return (
    <section aria-label="Recurring series" className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">Recurring this week</h3>
      <div className="flex flex-wrap gap-2">
        {series.map((entry) => (
          <Badge key={entry.seriesId} size="default" variant="outline">
            <RepeatIcon />
            {entry.title}
            <span className="text-muted-foreground">×{entry.occurrences.length}</span>
          </Badge>
        ))}
      </div>
    </section>
  );
}

export function CalendarPanel() {
  const [today] = useState(() => new Date());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [view, setView] = useState<CalendarViewMode>("week");

  const port = useNomiorPort(fixtureNomiorPort);
  const loadAccounts = useCallback(() => port.listCalendarAccounts(), [port]);
  const {
    data: accounts,
    error: accountsError,
    reload: reloadAccounts,
  } = usePortData(loadAccounts);

  const rangeStart = weekStart.toISOString();
  const rangeEnd = useMemo(() => addDays(weekStart, 7).toISOString(), [weekStart]);
  const loadEvents = useCallback(
    () => port.listCalendarEvents(rangeStart, rangeEnd),
    [port, rangeStart, rangeEnd],
  );
  const { data: events, error: eventsError, reload: reloadEvents } = usePortData(loadEvents);

  const loadError = accountsError ?? eventsError;
  const retryLoad = useCallback(() => {
    reloadAccounts();
    reloadEvents();
  }, [reloadAccounts, reloadEvents]);

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(
    weekStart,
    6,
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            aria-label="Previous week"
            onClick={() => setWeekStart((current) => startOfWeek(addDays(current, -7)))}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
          <Button onClick={() => setWeekStart(startOfWeek(new Date()))} size="sm" variant="outline">
            Today
          </Button>
          <Button
            aria-label="Next week"
            onClick={() => setWeekStart((current) => startOfWeek(addDays(current, 7)))}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <span className="text-sm font-medium">{weekLabel}</span>
        <div className="ms-auto">
          <ToggleGroup
            aria-label="Calendar view"
            onValueChange={(next) => {
              const value = next[0];
              if (value === "week" || value === "agenda") setView(value);
            }}
            value={[view]}
            variant="segmented"
          >
            <Toggle value="week">Week</Toggle>
            <Toggle value="agenda">Agenda</Toggle>
          </ToggleGroup>
        </div>
      </div>

      {accounts === null ? (
        loadError === null ? (
          <Skeleton className="h-4 w-64 rounded" />
        ) : null
      ) : (
        <AccountLegend accounts={accounts} />
      )}

      {loadError !== null ? (
        <PortErrorState label="Couldn't load the calendar." onRetry={retryLoad} />
      ) : events === null || accounts === null ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : view === "week" ? (
        <div className="overflow-x-auto rounded-xl border p-2">
          <WeekGrid accounts={accounts} events={events} today={today} weekStart={weekStart} />
        </div>
      ) : (
        <AgendaList accounts={accounts} events={events} weekStart={weekStart} />
      )}

      {events === null ? null : <RecurringSeriesSection events={events} />}
    </div>
  );
}
