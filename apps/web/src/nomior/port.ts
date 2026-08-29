/**
 * Data port the Nomior panels read through.
 *
 * The panels never talk to a transport directly: they call this interface. The
 * default implementation is the fixture port (`fixtures.ts`) so every panel
 * renders standalone; the RPC-backed implementation replaces it via
 * `NomiorPortProvider` once the server surface lands in `@t3tools/contracts`.
 *
 * @module nomior/port
 */
import { createContext, useContext } from "react";

import type {
  CalendarAccount,
  CalendarEventItem,
  ConnectorKind,
  ConnectorsOverview,
  ContextSnippet,
  MeetingDetail,
  MeetingItem,
  MemoryCandidate,
  MemoryCandidateResolution,
  ProviderInstanceItem,
  ReviewJob,
  SchedulerState,
} from "./types";

export interface NomiorDataPort {
  /**
   * True while the port serves bundled sample data. The UI labels everything
   * rendered from such a port as "Sample data"; the RPC-backed port must set
   * this to false.
   */
  readonly isFixture: boolean;

  listReviewJobs(): Promise<readonly ReviewJob[]>;
  requestManualReview(jobId: string): Promise<void>;

  searchContext(query: string): Promise<readonly ContextSnippet[]>;
  /** Opens the snippet's source (meeting, document, thread) in its own view. */
  openContextSource(snippetId: string): Promise<void>;
  listMemoryCandidates(): Promise<readonly MemoryCandidate[]>;
  resolveMemoryCandidate(id: string, resolution: MemoryCandidateResolution): Promise<void>;

  listCalendarAccounts(): Promise<readonly CalendarAccount[]>;
  /**
   * Events overlapping [rangeStart, rangeEnd), ISO timestamps.
   *
   * Known gaps the Google-backed implementation must close (the fixture and
   * the current week grid do not model them): all-day (date-only) events have
   * no representation in `CalendarEventItem`, concurrent events render fully
   * overlapped (no column-splitting), and the week grid only shows the
   * 08:00–20:00 window — events entirely outside it appear in the agenda view
   * only.
   */
  listCalendarEvents(rangeStart: string, rangeEnd: string): Promise<readonly CalendarEventItem[]>;

  /**
   * Meetings ingested by the Anarlog connector. Ordering is the panel's job,
   * not the port's.
   */
  listMeetings(): Promise<readonly MeetingItem[]>;
  getMeeting(meetingId: string): Promise<MeetingDetail>;

  /** Connector accounts plus everything the page needs to offer a Connect. */
  listConnectors(): Promise<ConnectorsOverview>;
  /** Empty string clears the id, which disables the Google flow entirely. */
  setGoogleClientId(clientId: string): Promise<void>;
  /**
   * Resolves to the authorization URL the client must open, or null when the
   * connector needs no browser step (Anarlog is a local store, not a sign-in).
   */
  connectConnector(kind: ConnectorKind): Promise<string | null>;
  disconnectConnector(accountId: string): Promise<void>;
  /** Resolves to the number of sources this run wrote or refreshed. */
  syncConnector(accountId: string): Promise<number>;

  listInstances(): Promise<readonly ProviderInstanceItem[]>;
  setInstancePinned(id: string, pinned: boolean): Promise<void>;
  getSchedulerState(): Promise<SchedulerState>;
  setAdvisoryMode(enabled: boolean): Promise<void>;
}

const NomiorPortContext = createContext<NomiorDataPort | null>(null);

export const NomiorPortProvider = NomiorPortContext.Provider;

export function useNomiorPort(fallback: () => NomiorDataPort): NomiorDataPort {
  const provided = useContext(NomiorPortContext);
  return provided ?? fallback();
}
