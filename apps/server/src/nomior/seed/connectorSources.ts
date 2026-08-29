/**
 * connectorSources - the scenario as the connector layer would have emitted it.
 *
 * The seeded meetings claim to match seeded calendar events. Rather than
 * asserting that by hand, the scenario is projected back into
 * `ConnectorSource` records and run through the real `assembleMeetings`, so
 * the claim is checked by the same matching code production uses.
 *
 * @module nomior/seed/connectorSources
 */
import {
  ConnectorAccountId,
  ConnectorDriverKind,
  type ConnectorSource,
} from "../connectors/Records.ts";

import {
  seedAnarlogAccount,
  seedCalendarEvents,
  seedMeetings,
  type SeedCalendarEvent,
  type SeedMeeting,
} from "./scenario.ts";

const ANARLOG_DRIVER = ConnectorDriverKind.make("anarlog");
const GOOGLE_CALENDAR_DRIVER = ConnectorDriverKind.make("googleCalendar");
const ANARLOG_ACCOUNT = ConnectorAccountId.make(seedAnarlogAccount.accountId);

export const transcriptConnectorSource = (meeting: SeedMeeting): ConnectorSource => ({
  sourceId: meeting.meetingId,
  kind: "meeting_transcript",
  title: meeting.title,
  startedAt: meeting.startsAt,
  endedAt: meeting.endsAt,
  participants: meeting.participants.map((name) => ({ name })),
  links: {
    meetingSessionId: meeting.meetingId,
    calendarEventId: meeting.calendarEventId,
    ...(meeting.seriesId === null ? {} : { recurringSeriesId: meeting.seriesId }),
  },
  provenance: {
    driverKind: ANARLOG_DRIVER,
    accountId: ANARLOG_ACCOUNT,
    externalId: meeting.meetingId,
    externalUpdatedAt: meeting.endsAt,
  },
});

export const calendarConnectorSource = (event: SeedCalendarEvent): ConnectorSource => ({
  sourceId: event.eventId,
  kind: "calendar_event",
  title: event.title,
  startedAt: event.startsAt,
  endedAt: event.endsAt,
  participants: event.attendees.map((email) => ({ email })),
  links: {
    calendarEventId: event.eventId,
    ...(event.recurringSeriesId === null ? {} : { recurringSeriesId: event.recurringSeriesId }),
  },
  provenance: {
    driverKind: GOOGLE_CALENDAR_DRIVER,
    accountId: ConnectorAccountId.make(event.accountId),
    externalId: event.eventId,
  },
});

export const seedTranscriptSources: ReadonlyArray<ConnectorSource> =
  seedMeetings.map(transcriptConnectorSource);

export const seedCalendarSources: ReadonlyArray<ConnectorSource> =
  seedCalendarEvents.map(calendarConnectorSource);
