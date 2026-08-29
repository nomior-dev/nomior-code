import { ArrowLeftIcon, CalendarCheckIcon, FileTextIcon, MicOffIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { fixtureNomiorPort } from "./fixtures";
import {
  formatMeetingDay,
  formatMeetingDuration,
  formatMeetingStart,
  formatTurnOffset,
  groupTranscriptBySpeaker,
  orderMeetings,
  parseInlineEmphasis,
  parseNotesBlocks,
  participantInitials,
  participantLabel,
  participantSecondary,
  speakerLabel,
  summarizeParticipants,
  transcriptHasTiming,
} from "./meetings.logic";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { MeetingDetail, MeetingItem, MeetingParticipant, TranscriptTurn } from "./types";
import { usePortData } from "./usePortData";

/** A value the connector never supplied reads as muted italics, everywhere. */
const UNKNOWN_CLASS = "text-muted-foreground/80 italic";

type ReadingMode = "notes" | "transcript";

function ParticipantChip({ participant }: { participant: MeetingParticipant }) {
  const label = participantLabel(participant);
  const secondary = participantSecondary(participant);
  const chip = (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pe-2.5 ps-0.5 text-xs">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[10px] font-medium text-muted-foreground">
        {participantInitials(participant)}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
  if (secondary === null) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{secondary}</TooltipPopup>
    </Tooltip>
  );
}

function ParticipantList({ participants }: { participants: readonly MeetingParticipant[] }) {
  if (participants.length === 0) {
    return <p className={cn("text-xs", UNKNOWN_CLASS)}>No participants recorded.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {participants.map((participant, index) => (
        <li className="min-w-0" key={`${participantLabel(participant)}:${index}`}>
          <ParticipantChip participant={participant} />
        </li>
      ))}
    </ul>
  );
}

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInlineEmphasis(text).map((segment, index) =>
        segment.strong ? (
          <strong className="font-semibold text-foreground" key={index}>
            {segment.text}
          </strong>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-base font-semibold",
  2: "text-sm font-semibold",
  3: "text-sm font-medium",
};

/**
 * Notes read as a document: prose measure, headings, lists. Deliberately a
 * different register from the transcript below it, which is a log.
 */
export function NotesReader({ notes }: { notes: string | null }) {
  if (notes === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No notes</EmptyTitle>
          <EmptyDescription>
            Nobody wrote anything down for this one. The transcript is still here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const blocks = parseNotesBlocks(notes);
  if (blocks.length === 0) {
    return <p className={cn("text-sm", UNKNOWN_CLASS)}>The notes document is empty.</p>;
  }
  return (
    <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h3 className={cn("mt-2 first:mt-0", HEADING_CLASS[block.level])} key={index}>
              <InlineText text={block.text} />
            </h3>
          );
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag
              className={cn(
                "flex flex-col gap-1.5 ps-5 text-muted-foreground",
                block.ordered ? "list-decimal" : "list-disc",
              )}
              key={index}
            >
              {block.items.map((item, itemIndex) => (
                <li className="ps-0.5" key={itemIndex}>
                  <InlineText text={item} />
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p className="text-muted-foreground" key={index}>
            <InlineText text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

/**
 * The transcript as speaker blocks. The timestamp gutter only exists when the
 * transcript carried timing — a column of zeros would claim every turn happened
 * at the start of the recording.
 */
export function TranscriptReader({ turns }: { turns: readonly TranscriptTurn[] }) {
  if (turns.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No transcript</EmptyTitle>
          <EmptyDescription>
            Ingest ran and found no speech in this recording. Nothing was dropped.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const timed = transcriptHasTiming(turns);
  return (
    <div className="flex flex-col gap-4">
      {timed ? null : (
        <p className={cn("text-xs", UNKNOWN_CLASS)}>
          This transcript arrived without timing, so the turns carry no timestamps.
        </p>
      )}
      <ol className="flex flex-col gap-4">
        {groupTranscriptBySpeaker(turns).map((block) => {
          const offset = formatTurnOffset(block.startMs);
          return (
            <li className="flex min-w-0 gap-3" key={block.id}>
              {timed ? (
                <span className="w-14 shrink-0 pt-px text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {offset ?? (
                    <span aria-label="No timestamp for this turn" className="opacity-50">
                      —
                    </span>
                  )}
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-xs font-medium",
                    block.speaker === null ? UNKNOWN_CLASS : "text-foreground",
                  )}
                >
                  {speakerLabel(block.speaker)}
                </p>
                <div className="mt-1 flex flex-col gap-1.5 text-sm leading-relaxed text-muted-foreground">
                  {block.turns.map((turn) => (
                    <p key={turn.id}>{turn.text}</p>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function MeetingListRow({
  meeting,
  isActive,
  onSelect,
}: {
  meeting: MeetingItem;
  isActive: boolean;
  onSelect: (meetingId: string) => void;
}) {
  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 text-left",
        isActive
          ? "border-border bg-accent text-accent-foreground"
          : "border-transparent hover:bg-accent/50",
      )}
      onClick={() => onSelect(meeting.id)}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{meeting.title}</span>
        {meeting.hasNotes ? (
          <FileTextIcon aria-label="Has notes" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        {meeting.turnCount === 0 ? (
          <MicOffIcon
            aria-label="No transcript"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={meeting.startedAt === null ? UNKNOWN_CLASS : undefined}>
          {formatMeetingDay(meeting.startedAt)}
        </span>
        <span aria-hidden>·</span>
        <span className={meeting.durationMs === null ? UNKNOWN_CLASS : undefined}>
          {formatMeetingDuration(meeting.durationMs)}
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {summarizeParticipants(meeting.participants)}
      </span>
    </button>
  );
}

/**
 * One meeting, read. Keyed by meeting id at the call site so switching
 * meetings picks the reading mode again rather than keeping the last one.
 */
export function MeetingReader({ detail }: { detail: MeetingDetail }) {
  const { meeting, transcript, notes } = detail;
  const [mode, setMode] = useState<ReadingMode>(notes === null ? "transcript" : "notes");

  return (
    // Capped: the pane is as wide as the display, and notes and transcript are
    // prose, which stops being readable long before it stops fitting.
    <article className="flex min-w-0 max-w-3xl flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-lg font-semibold">{meeting.title}</h2>
          {meeting.calendarEventId !== null ? (
            <Badge size="sm" variant="secondary">
              <CalendarCheckIcon />
              On the calendar
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={meeting.startedAt === null ? UNKNOWN_CLASS : undefined}>
            {formatMeetingStart(meeting.startedAt)}
          </span>
          <span aria-hidden>·</span>
          <span className={meeting.durationMs === null ? UNKNOWN_CLASS : undefined}>
            {formatMeetingDuration(meeting.durationMs)}
          </span>
          <span aria-hidden>·</span>
          <span className={meeting.turnCount === 0 ? UNKNOWN_CLASS : undefined}>
            {meeting.turnCount === 0 ? "No transcript" : `${meeting.turnCount} turns`}
          </span>
        </div>
        <ParticipantList participants={meeting.participants} />
      </header>

      <Separator />

      <ToggleGroup
        aria-label="Meeting reading mode"
        onValueChange={(next) => {
          const value = next[0];
          if (value === "notes" || value === "transcript") setMode(value);
        }}
        value={[mode]}
        variant="segmented"
      >
        <Toggle value="notes">Notes</Toggle>
        <Toggle value="transcript">Transcript</Toggle>
      </ToggleGroup>

      {mode === "notes" ? <NotesReader notes={notes} /> : <TranscriptReader turns={transcript} />}
    </article>
  );
}

function MeetingListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  );
}

export function MeetingsPanel() {
  const port = useNomiorPort(fixtureNomiorPort);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadMeetings = useCallback(
    (): Promise<readonly MeetingItem[]> => port.listMeetings(),
    [port],
  );
  const {
    data: meetings,
    error: meetingsError,
    reload: reloadMeetings,
  } = usePortData(loadMeetings);

  const ordered = meetings === null ? null : orderMeetings(meetings);
  // A selection made against another environment's list does not survive into
  // this one: fall back to the newest meeting rather than to a 404.
  const activeId =
    (selectedId !== null && ordered?.some((meeting) => meeting.id === selectedId) === true
      ? selectedId
      : ordered?.[0]?.id) ?? null;

  const loadDetail = useCallback(
    (): Promise<MeetingDetail | null> =>
      activeId === null ? Promise.resolve(null) : port.getMeeting(activeId),
    [port, activeId],
  );
  const { data: detail, error: detailError, reload: reloadDetail } = usePortData(loadDetail);
  // `usePortData` keeps the last value while the next read is in flight, which
  // would leave the previous meeting on screen under the new one's highlight.
  const isDetailReady = detail !== null && detail.meeting.id === activeId;

  if (meetingsError !== null) {
    return <PortErrorState label="Couldn't load meetings." onRetry={reloadMeetings} />;
  }

  if (ordered !== null && ordered.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No meetings yet</EmptyTitle>
          <EmptyDescription>
            Meetings land here as recorded sessions are transcribed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    // One row that fills the page: each pane scrolls inside it, so a long list
    // never scrolls the meeting being read out of view.
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <section
        aria-label="Meetings"
        className={cn(
          "flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto",
          selectedId !== null && "hidden md:flex",
        )}
      >
        {ordered === null ? (
          <MeetingListSkeleton />
        ) : (
          ordered.map((meeting) => (
            <MeetingListRow
              isActive={meeting.id === activeId}
              key={meeting.id}
              meeting={meeting}
              onSelect={setSelectedId}
            />
          ))
        )}
      </section>

      <section
        aria-label="Meeting"
        className={cn(
          "flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto md:border-s md:border-border md:ps-6",
          selectedId === null && "hidden md:flex",
        )}
      >
        <Button
          className="self-start md:hidden"
          onClick={() => setSelectedId(null)}
          size="xs"
          variant="ghost-muted"
        >
          <ArrowLeftIcon className="size-3.5" />
          All meetings
        </Button>
        {detailError !== null ? (
          <PortErrorState label="Couldn't load this meeting." onRetry={reloadDetail} />
        ) : !isDetailReady || detail === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-64 rounded" />
            <Skeleton className="h-4 w-48 rounded" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : (
          <MeetingReader detail={detail} key={detail.meeting.id} />
        )}
      </section>
    </div>
  );
}
