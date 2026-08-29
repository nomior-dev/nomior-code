/**
 * CalendarEventStore — calendar events kept as events.
 *
 * The Google driver turns each event into a `ConnectorRecord` for retrieval;
 * that path loses the grid's shape (which account owns the event, which
 * series it belongs to, what meeting artifacts exist). This store owns
 * `nomior_calendar_events`, one row per (account, event).
 *
 * Timestamps are compared as strings by the window query, which is only
 * correct while every row uses one fixed format: writes go through
 * `normalizeTimestamp`, which renders UTC ISO-8601 with millisecond
 * precision (`2026-08-29T09:30:00.000Z`). A row written in any other shape
 * will sort and filter wrongly.
 *
 * @module nomior/connectors/calendar/CalendarEventStore
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../../../persistence/Errors.ts";
import { ConnectorAccountId } from "../Records.ts";

/**
 * Renders any parseable instant as UTC ISO-8601 with millisecond precision —
 * the single format the window query's string comparison depends on.
 * `Option.none()` for input that is not an instant (a date-only value is
 * parseable and becomes UTC midnight, so callers that must not invent
 * boundaries reject those before calling).
 */
export const normalizeTimestamp = (value: string): Option.Option<IsoDateTime> =>
  Option.map(DateTime.make(value), DateTime.formatIso);

const BooleanFromInt = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (stored: number) => stored !== 0,
      encode: (value: boolean): number => (value ? 1 : 0),
    }),
  ),
);

const eventFields = {
  id: TrimmedNonEmptyString,
  accountId: ConnectorAccountId,
  title: Schema.String,
  start: IsoDateTime,
  end: IsoDateTime,
  /** Google `recurringEventId`; events sharing one belong to a series. */
  recurringSeriesId: Schema.NullOr(Schema.String),
  meetingId: Schema.NullOr(Schema.String),
  hasTranscript: Schema.Boolean,
  hasNotes: Schema.Boolean,
};

export const StoredCalendarEvent = Schema.Struct(eventFields);
export type StoredCalendarEvent = typeof StoredCalendarEvent.Type;

const dbFields = {
  ...eventFields,
  hasTranscript: BooleanFromInt,
  hasNotes: BooleanFromInt,
};

const CalendarEventDbRow = Schema.Struct(dbFields);
const CalendarEventUpsertRow = Schema.Struct({ ...dbFields, updatedAt: IsoDateTime });

export interface CalendarEventWindow {
  /** Half-open window [rangeStart, rangeEnd). */
  readonly rangeStart: IsoDateTime;
  readonly rangeEnd: IsoDateTime;
}

export class CalendarEventStore extends Context.Service<
  CalendarEventStore,
  {
    /** Idempotent on (accountId, id): re-upserting an event overwrites its row whole. */
    readonly upsertMany: (
      events: ReadonlyArray<StoredCalendarEvent>,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /** Every event overlapping the window, ordered by start then id. */
    readonly listWindow: (
      window: CalendarEventWindow,
    ) => Effect.Effect<ReadonlyArray<StoredCalendarEvent>, PersistenceSqlError>;
    readonly deleteForAccount: (
      accountId: ConnectorAccountId,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/nomior/connectors/calendar/CalendarEventStore") {}

/** A stored row that no longer decodes is a persistence fault, not a caller error. */
const toStoreError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? new PersistenceSqlError({
        operation,
        detail: "stored calendar event row does not match the expected shape",
        cause,
      })
    : toPersistenceSqlError(operation)(cause);

const WINDOW_COLUMNS = `
  event_id AS "id",
  account_id AS "accountId",
  title,
  starts_at AS "start",
  ends_at AS "end",
  recurring_series_id AS "recurringSeriesId",
  meeting_id AS "meetingId",
  has_transcript AS "hasTranscript",
  has_notes AS "hasNotes"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: CalendarEventUpsertRow,
    execute: (row) =>
      sql`
        INSERT INTO nomior_calendar_events (
          event_id,
          account_id,
          title,
          starts_at,
          ends_at,
          recurring_series_id,
          meeting_id,
          has_transcript,
          has_notes,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.accountId},
          ${row.title},
          ${row.start},
          ${row.end},
          ${row.recurringSeriesId},
          ${row.meetingId},
          ${row.hasTranscript},
          ${row.hasNotes},
          ${row.updatedAt}
        )
        ON CONFLICT (account_id, event_id)
        DO UPDATE SET
          title = excluded.title,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          recurring_series_id = excluded.recurring_series_id,
          meeting_id = excluded.meeting_id,
          has_transcript = excluded.has_transcript,
          has_notes = excluded.has_notes,
          updated_at = excluded.updated_at
      `,
  });

  const listWindowRows = SqlSchema.findAll({
    Request: Schema.Struct({ rangeStart: IsoDateTime, rangeEnd: IsoDateTime }),
    Result: CalendarEventDbRow,
    execute: ({ rangeStart, rangeEnd }) =>
      sql`
        SELECT ${sql.literal(WINDOW_COLUMNS)}
        FROM nomior_calendar_events
        WHERE starts_at < ${rangeEnd} AND ends_at > ${rangeStart}
        ORDER BY starts_at ASC, event_id ASC
      `,
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  return CalendarEventStore.of({
    upsertMany: (events) =>
      nowIso.pipe(
        Effect.flatMap((updatedAt) =>
          Effect.forEach(events, (event) => upsertRow({ ...event, updatedAt }), {
            discard: true,
          }),
        ),
        Effect.mapError(toStoreError("calendarEvents.upsertMany")),
        Effect.withSpan("CalendarEventStore.upsertMany"),
      ),
    listWindow: (window) =>
      listWindowRows(window).pipe(
        Effect.mapError(toStoreError("calendarEvents.listWindow")),
        Effect.withSpan("CalendarEventStore.listWindow"),
      ),
    deleteForAccount: (accountId) =>
      sql`
        DELETE FROM nomior_calendar_events
        WHERE account_id = ${accountId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("calendarEvents.deleteForAccount")),
        Effect.withSpan("CalendarEventStore.deleteForAccount"),
      ),
  });
});

export const layer = Layer.effect(CalendarEventStore, make);
