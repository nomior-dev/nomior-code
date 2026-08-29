/**
 * Fixture connectors, hand-written.
 *
 * Like `fixtures.meetings`, this is the part of the sample world the seed
 * scenario does not carry: a connector is a live credential and a machine-local
 * path, neither of which a generated scenario can invent.
 *
 * The default set exists to make every account state reachable on the page
 * without a server — one healthy account, one whose last sync failed and may
 * recover, one whose access was revoked and will not, and one that has never
 * synced at all. The alternates below are the states a single overview cannot
 * show at the same time (no client id, a remote client, an account that
 * is absent or refused); the panel tests render against those directly.
 *
 * Google connector ids match the calendar accounts in `fixtures.generated.ts`,
 * so the two surfaces name the same accounts instead of two parallel worlds.
 *
 * @module nomior/fixtures.connectors
 */
import type { ConnectorKind, ConnectorStatus, GoogleClientState } from "./types";

export interface ConnectorAccountScenario {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly status: ConnectorStatus;
  /** Null is an account nobody has filed under a project yet. */
  readonly projectId: string | null;
  /** Hours before "now". Null is an account that has never finished a sync. */
  readonly lastSyncedAgoHours: number | null;
  readonly detail: string | null;
}

export const connectorAccountScenarios: readonly ConnectorAccountScenario[] = [
  {
    id: "google-work",
    kind: "googleCalendar",
    displayName: "work@nomior.example",
    status: "connected",
    projectId: "nomior-code",
    lastSyncedAgoHours: 2,
    detail: null,
  },
  {
    // Transient: a quota reset clears it, so the row points at Sync.
    id: "google-personal",
    kind: "googleCalendar",
    displayName: "personal@gmail.example",
    status: "error",
    // Unassigned on purpose: the row has to say why its material is missing
    // from every project's search.
    projectId: null,
    lastSyncedAgoHours: 27,
    detail: "Google refused the events list with 429: this client's daily quota is spent.",
  },
  {
    // Terminal, and never synced: two different holes in one row.
    id: "gmail-work",
    kind: "gmail",
    displayName: "work@nomior.example",
    status: "revoked",
    projectId: "nomior-code",
    lastSyncedAgoHours: null,
    detail: "The token was revoked from the Google account's security settings.",
  },
];

/**
 * The shipped case: the build carries its own client id, so the page is one
 * button. Only the last four characters of it ever leave the server.
 */
export const GOOGLE_CLIENT_CONFIGURED: GoogleClientState = {
  configured: true,
  source: "bundled",
  clientIdHint: "j4kq",
};

/** An environment pointed at the operator's own Google Cloud project. */
export const GOOGLE_CLIENT_OPERATOR: GoogleClientState = {
  configured: true,
  source: "operator",
  clientIdHint: "7t2v",
};

/** A build with no bundled id — a fork or a source checkout — and none set. */
export const GOOGLE_CLIENT_UNCONFIGURED: GoogleClientState = {
  configured: false,
  source: "none",
  clientIdHint: null,
};
