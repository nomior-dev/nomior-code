/**
 * GoogleCalendarDriver — incremental Google Calendar ingestion.
 *
 * Sync protocol per Google's sync guide: page `events.list` carrying the
 * stored `syncToken`; a 410 GONE means the token expired server-side, so
 * the driver drops it and performs a full resync in the same call,
 * reporting `cursorInvalidated: true`. Recurring instances carry
 * `recurringEventId`, preserved as `links.recurringSeriesId` for series
 * grouping downstream.
 *
 * @module nomior/connectors/google/GoogleCalendarDriver
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectorDriver, ConnectorHealth, ConnectorInstance } from "../ConnectorDriver.ts";
import { ConnectorDriverError, ConnectorSyncError } from "../Errors.ts";
import {
  type ConnectorAccountId,
  ConnectorDriverKind,
  type ConnectorRecord,
  type ConnectorSyncResult,
} from "../Records.ts";
import {
  type GoogleApiError,
  type GoogleCalendarEvent,
  GoogleCalendarPort,
  GoogleTokenPort,
  isCursorInvalidationError,
  isGoogleApiError,
} from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

const DRIVER_KIND = ConnectorDriverKind.make("googleCalendar");
/** Hard bound on pages per sync call — a runaway loop fails loudly. */
const MAX_PAGES_PER_SYNC = 100;
/**
 * Floor for token-less (initial/full) syncs. Without it a busy decade-old
 * calendar walks its entire history, blows the page bound, and can never
 * finish a first sync. `timeMin` + `syncToken` together is what Google
 * forbids; `timeMin` alone still yields a `nextSyncToken`.
 */
const INITIAL_SYNC_WINDOW = Duration.days(90);

export const GoogleCalendarConnectorConfig = Schema.Struct({
  calendarId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("primary"))),
});
export type GoogleCalendarConnectorConfig = typeof GoogleCalendarConnectorConfig.Type;

const decodeConfig = Schema.decodeUnknownSync(GoogleCalendarConnectorConfig);

const CalendarCursor = Schema.Struct({
  syncToken: Schema.String,
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(CalendarCursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(CalendarCursor));

export type GoogleCalendarDriverEnv = GoogleCalendarPort | GoogleTokenVault | GoogleTokenPort;

const normalizeEvent = (
  accountId: ConnectorAccountId,
  event: GoogleCalendarEvent,
): ConnectorRecord => {
  const startedAt = event.start?.dateTime ?? event.start?.date;
  const endedAt = event.end?.dateTime ?? event.end?.date;
  const sourceId = `event:${event.id}`;
  const title = event.summary ?? "";
  return {
    source: {
      sourceId,
      kind: "calendar_event",
      title,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      participants: (event.attendees ?? []).map((attendee) => ({
        ...(attendee.displayName === undefined ? {} : { name: attendee.displayName }),
        ...(attendee.email === undefined ? {} : { email: attendee.email }),
      })),
      links: {
        calendarEventId: event.id,
        ...(event.recurringEventId === undefined
          ? {}
          : { recurringSeriesId: event.recurringEventId }),
      },
      provenance: {
        driverKind: DRIVER_KIND,
        accountId,
        externalId: event.id,
        ...(event.updated === undefined ? {} : { externalUpdatedAt: event.updated }),
      },
    },
    // A calendar event's retrievable text is its title; description bodies
    // are deliberately not ingested in v1 (they mostly carry join links
    // and boilerplate; the meeting transcript is the content source).
    chunks:
      title === "" ? [] : [{ chunkId: `${sourceId}/chunk/0`, sourceId, index: 0, text: title }],
  };
};

export const GoogleCalendarDriver: ConnectorDriver<
  GoogleCalendarConnectorConfig,
  GoogleCalendarDriverEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Google Calendar",
    supportsMultipleAccounts: true,
  },
  configSchema: GoogleCalendarConnectorConfig,
  defaultConfig: (): GoogleCalendarConnectorConfig => decodeConfig({}),
  create: ({ accountId, displayName, config }) =>
    Effect.gen(function* () {
      const calendarPort = yield* GoogleCalendarPort;
      const tokenPort = yield* GoogleTokenPort;
      const vault = yield* GoogleTokenVault;

      const syncError = (operation: string, detail?: string, cause?: unknown) =>
        new ConnectorSyncError({
          driverKind: DRIVER_KIND,
          accountId,
          operation,
          ...(detail === undefined ? {} : { detail }),
          ...(cause === undefined ? {} : { cause }),
        });

      /**
       * One full page walk with (or without) a sync token. Fails with the
       * raw `GoogleApiError` so the caller can branch on 410.
       */
      const pageThrough = (
        syncToken: string | undefined,
      ): Effect.Effect<ConnectorSyncResult, GoogleApiError | ConnectorSyncError> =>
        Effect.gen(function* () {
          // Token-less walks are time-bounded; token walks must not be.
          const timeMin =
            syncToken === undefined
              ? DateTime.formatIso(
                  DateTime.makeUnsafe(
                    (yield* Clock.currentTimeMillis) - Duration.toMillis(INITIAL_SYNC_WINDOW),
                  ),
                )
              : undefined;
          const records: Array<ConnectorRecord> = [];
          let pageToken: string | undefined;
          let nextSyncToken: string | undefined;
          for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
            const result = yield* calendarPort.listEvents({
              accountId,
              calendarId: config.calendarId,
              ...(syncToken === undefined ? {} : { syncToken }),
              ...(timeMin === undefined ? {} : { timeMin }),
              ...(pageToken === undefined ? {} : { pageToken }),
            });
            for (const event of result.items) {
              // Cancelled instances are tombstones in incremental mode;
              // nothing to index. Deletion propagation becomes the ingest
              // layer's concern once it tracks removals.
              if (event.status === "cancelled") {
                continue;
              }
              records.push(normalizeEvent(accountId, event));
            }
            if (result.nextPageToken !== undefined) {
              pageToken = result.nextPageToken;
              continue;
            }
            nextSyncToken = result.nextSyncToken;
            break;
          }
          if (nextSyncToken === undefined) {
            return yield* syncError(
              "events.list",
              `no nextSyncToken after ${MAX_PAGES_PER_SYNC} pages — aborting instead of looping`,
            );
          }
          return {
            records,
            nextCursor: encodeCursor({ syncToken: nextSyncToken }),
            cursorInvalidated: false,
          } satisfies ConnectorSyncResult;
        });

      const sync: ConnectorInstance["sync"] = ({ cursor }) =>
        Effect.gen(function* () {
          let syncToken: string | undefined;
          let staleCursor = false;
          if (cursor !== null) {
            const decoded = yield* decodeCursor(cursor).pipe(
              Effect.map(Option.some),
              Effect.orElseSucceed(() => Option.none<{ readonly syncToken: string }>()),
            );
            if (Option.isSome(decoded)) {
              syncToken = decoded.value.syncToken;
            } else {
              staleCursor = true;
            }
          }

          const result = yield* pageThrough(syncToken).pipe(
            // 410 GONE (or an equivalent invalidation): the stored token
            // expired server-side → drop it and full-resync in this call.
            Effect.catchIf(
              (error): error is GoogleApiError =>
                syncToken !== undefined &&
                isGoogleApiError(error) &&
                isCursorInvalidationError(error),
              () =>
                pageThrough(undefined).pipe(
                  Effect.map((full) => ({ ...full, cursorInvalidated: true })),
                ),
            ),
            Effect.mapError((error) =>
              isGoogleApiError(error) ? syncError("events.list", error.message, error) : error,
            ),
          );
          return staleCursor ? { ...result, cursorInvalidated: true } : result;
        });

      const health: Effect.Effect<ConnectorHealth> = vault.get(accountId).pipe(
        Effect.map(
          (tokens): ConnectorHealth =>
            Option.isSome(tokens)
              ? { _tag: "ok" }
              : {
                  _tag: "unauthorized",
                  detail: "no Google credentials stored for this account; connect it first",
                },
        ),
        Effect.orElseSucceed(
          (): ConnectorHealth => ({
            _tag: "unavailable",
            detail: "unable to read the Google token vault",
          }),
        ),
      );

      return {
        accountId,
        driverKind: DRIVER_KIND,
        displayName,
        probe: vault.get(accountId).pipe(
          Effect.map((tokens) => ({
            present: true,
            authorized: Option.isSome(tokens),
            ...(Option.isSome(tokens) ? {} : { detail: "account not connected" }),
          })),
          Effect.orElseSucceed(() => ({
            present: true,
            authorized: false,
            detail: "unable to read the Google token vault",
          })),
        ),
        sync,
        health,
        revoke: Effect.gen(function* () {
          const tokens = yield* vault
            .get(accountId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(tokens)) {
            // Best-effort server-side revocation; local removal is what
            // guarantees this install stops using the account.
            yield* tokenPort
              .revokeToken({ token: tokens.value.refreshToken ?? tokens.value.accessToken })
              .pipe(Effect.ignore);
          }
          yield* vault.remove(accountId).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectorDriverError({
                  driverKind: DRIVER_KIND,
                  accountId,
                  detail: "failed to remove stored Google credentials",
                  cause,
                }),
            ),
          );
        }),
      } satisfies ConnectorInstance;
    }),
};
