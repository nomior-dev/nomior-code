import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon, MicIcon, RepeatIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import {
  accountColor,
  CALENDAR_VIEWS,
  calendarRangeLabel,
  calendarViewLabel,
  eventsForAccounts,
  isCalendarView,
  shiftCalendarDate,
  toCalendarEvents,
  toCalendarResources,
  visibleAccounts,
  type CalendarViewId,
  type NomiorEventData,
} from "./calendar.logic";
import { EventCalendar } from "./eventCalendar/event-calendar";
import { EventCalendarContent } from "./eventCalendar/event-calendar-content";
import type { EventCalendarRenderEventProps } from "./eventCalendar/event-calendar";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { CalendarAccount } from "./types";
import { usePortData } from "./usePortData";

/**
 * The window the time-grid views draw. Wider than a working day so an early
 * standup and a late call are both on the grid rather than clipped off it; the
 * view scrolls to `scrollToHour` on open so the ordinary day is what you see.
 */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22;

function ArtifactChips({ meeting }: { meeting: NomiorEventData["meeting"] }) {
  if (meeting === null) return null;
  return (
    <>
      {meeting.hasTranscript ? (
        <MicIcon aria-label="Transcript linked" className="size-2.5 shrink-0 opacity-70" />
      ) : null}
      {meeting.hasNotes ? (
        <FileTextIcon aria-label="Notes linked" className="size-2.5 shrink-0 opacity-70" />
      ) : null}
    </>
  );
}

/**
 * The body of one event block.
 *
 * The calendar's own chip is replaced rather than wrapped because the thing
 * that makes this calendar Nomior's — whether a slot already has a transcript
 * or notes behind it — has to survive into every view, and there is no seam to
 * append to the default one. Position, size and colour still come from the
 * component around it.
 */
function EventBody({ occurrence, view }: EventCalendarRenderEventProps<NomiorEventData>) {
  const { event } = occurrence;
  const data = event.data;
  return (
    <>
      {view === "month" || view === "agenda" ? (
        <span
          aria-hidden
          className="-me-0.5 size-1.5 shrink-0 rounded-full bg-(--ec-event-color)"
        />
      ) : null}
      {event.recurringEventId === undefined ? null : (
        <RepeatIcon aria-hidden className="size-2.5 shrink-0 opacity-70" />
      )}
      <span className="truncate font-medium">{event.title}</span>
      <ArtifactChips meeting={data?.meeting ?? null} />
    </>
  );
}

/**
 * The accounts, and the filter.
 *
 * Accounts are the only way this calendar divides events, so the legend and the
 * filter are one control rather than two: the thing that tells you which colour
 * is whose is the thing you press to put it away. Pressed-out accounts are
 * dimmed and still listed — a filtered-away account that vanishes from the
 * legend is a filter with no way back.
 */
export function AccountLegend({
  accounts,
  hiddenAccountIds,
  onToggleAccount,
}: {
  accounts: readonly CalendarAccount[];
  hiddenAccountIds: ReadonlySet<string>;
  onToggleAccount: (accountId: string) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {accounts.map((account) => {
        const isHidden = hiddenAccountIds.has(account.id);
        return (
          <button
            aria-pressed={!isHidden}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
              isHidden
                ? "border-transparent text-muted-foreground/60 hover:text-muted-foreground"
                : "border-border text-foreground hover:bg-accent",
            )}
            key={account.id}
            onClick={() => onToggleAccount(account.id)}
            type="button"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                accountColor(account.colorIndex).dot,
                isHidden && "opacity-32",
              )}
            />
            {account.email}
          </button>
        );
      })}
    </div>
  );
}

export function CalendarPanel() {
  const [view, setView] = useState<CalendarViewId>("week");
  const [date, setDate] = useState(() => new Date());

  const port = useNomiorPort(fixtureNomiorPort);
  const loadAccounts = useCallback(() => port.listCalendarAccounts(), [port]);
  const {
    data: accounts,
    error: accountsError,
    reload: reloadAccounts,
  } = usePortData(loadAccounts);

  // The grid decides what it needs — a month view paints outside days, an
  // agenda runs past the month's end — so the fetch window follows the rendered
  // range rather than being derived a second time from `view` and `date`.
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const rangeRef = useRef<{ start: string; end: string } | null>(null);
  const handleRangeChange = useCallback((info: { range: { start: Date; end: Date } }) => {
    const next = { start: info.range.start.toISOString(), end: info.range.end.toISOString() };
    const current = rangeRef.current;
    if (current !== null && current.start === next.start && current.end === next.end) return;
    rangeRef.current = next;
    setRange(next);
  }, []);

  const loadEvents = useCallback(
    () => (range === null ? Promise.resolve([]) : port.listCalendarEvents(range.start, range.end)),
    [port, range],
  );
  const { data: events, error: eventsError, reload: reloadEvents } = usePortData(loadEvents);

  const [hiddenAccountIds, setHiddenAccountIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggleAccount = useCallback((accountId: string) => {
    setHiddenAccountIds((current) => {
      const next = new Set(current);
      if (!next.delete(accountId)) next.add(accountId);
      return next;
    });
  }, []);

  const shown = useMemo(
    () => visibleAccounts(accounts ?? [], hiddenAccountIds),
    [accounts, hiddenAccountIds],
  );
  const calendarEvents = useMemo(
    () => toCalendarEvents(eventsForAccounts(events ?? [], shown), accounts ?? []),
    [events, accounts, shown],
  );
  const resources = useMemo(() => toCalendarResources(shown), [shown]);

  const loadError = accountsError ?? eventsError;
  const retryLoad = useCallback(() => {
    reloadAccounts();
    reloadEvents();
  }, [reloadAccounts, reloadEvents]);

  const renderEvent = useCallback(
    (props: EventCalendarRenderEventProps<NomiorEventData>) => <EventBody {...props} />,
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            aria-label={`Previous ${calendarViewLabel(view).toLowerCase()}`}
            onClick={() => setDate((current) => shiftCalendarDate(current, view, -1))}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
          <Button onClick={() => setDate(new Date())} size="sm" variant="outline">
            Today
          </Button>
          <Button
            aria-label={`Next ${calendarViewLabel(view).toLowerCase()}`}
            onClick={() => setDate((current) => shiftCalendarDate(current, view, 1))}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <span className="text-sm font-medium">{calendarRangeLabel(date, view)}</span>
        {calendarEvents.length === 0 ? null : (
          <Badge size="sm" variant="secondary">
            {calendarEvents.length}
          </Badge>
        )}
        <div className="ms-auto">
          <ToggleGroup
            aria-label="Calendar view"
            onValueChange={(next) => {
              const value = next[0];
              if (isCalendarView(value)) setView(value);
            }}
            value={[view]}
            variant="segmented"
          >
            {CALENDAR_VIEWS.map((id) => (
              <Toggle key={id} value={id}>
                {calendarViewLabel(id)}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {accounts === null ? (
        loadError === null ? (
          <Skeleton className="h-4 w-64 rounded" />
        ) : null
      ) : (
        <AccountLegend
          accounts={accounts}
          hiddenAccountIds={hiddenAccountIds}
          onToggleAccount={toggleAccount}
        />
      )}

      {loadError !== null ? (
        <PortErrorState label="Couldn't load the calendar." onRetry={retryLoad} />
      ) : (
        <EventCalendar<NomiorEventData>
          className="min-h-0 flex-1 overflow-hidden rounded-xl border"
          date={date}
          dayEndHour={DAY_END_HOUR}
          dayStartHour={DAY_START_HOUR}
          events={calendarEvents}
          // Nothing here writes back to Google, so nothing here pretends to:
          // no dragging an event to a new time, no dragging out a new one.
          interactions={{ drag: false, resize: false, selectSlot: false }}
          loading={events === null || accounts === null}
          onDateChange={setDate}
          onRangeChange={handleRangeChange}
          onViewChange={(next) => {
            if (isCalendarView(next)) setView(next);
          }}
          renderAgendaEvent={renderEvent}
          renderEvent={renderEvent}
          resources={resources}
          view={view}
          views={[...CALENDAR_VIEWS]}
        >
          <EventCalendarContent className="min-h-0 flex-1" />
        </EventCalendar>
      )}
    </div>
  );
}
