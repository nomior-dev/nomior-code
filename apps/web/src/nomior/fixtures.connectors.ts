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
 * show at the same time (no client id, a remote client, an Anarlog store that
 * is absent or refused); the panel tests render against those directly.
 *
 * Google connector ids match the calendar accounts in `fixtures.generated.ts`,
 * so the two surfaces name the same accounts instead of two parallel worlds.
 *
 * @module nomior/fixtures.connectors
 */
import type { AnarlogState, ConnectorKind, ConnectorStatus, GoogleClientState } from "./types";

export interface ConnectorAccountScenario {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly status: ConnectorStatus;
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
    lastSyncedAgoHours: 2,
    detail: null,
  },
  {
    // Transient: a quota reset clears it, so the row points at Sync.
    id: "google-personal",
    kind: "googleCalendar",
    displayName: "personal@gmail.example",
    status: "error",
    lastSyncedAgoHours: 27,
    detail: "Google refused the events list with 429: this client's daily quota is spent.",
  },
  {
    // Terminal, and never synced: two different holes in one row.
    id: "gmail-work",
    kind: "gmail",
    displayName: "work@nomior.example",
    status: "revoked",
    lastSyncedAgoHours: null,
    detail: "The token was revoked from the Google account's security settings.",
  },
  {
    id: "anarlog-local",
    kind: "anarlog",
    displayName: "Anarlog on this machine",
    status: "connected",
    lastSyncedAgoHours: 5,
    detail: null,
  },
];

/** Only the last four characters of a client id ever leave the server. */
export const GOOGLE_CLIENT_CONFIGURED: GoogleClientState = {
  configured: true,
  clientIdHint: "j4kq",
};

/** First run, and the state clearing the id returns the environment to. */
export const GOOGLE_CLIENT_UNCONFIGURED: GoogleClientState = {
  configured: false,
  clientIdHint: null,
};

export const ANARLOG_STORE_PATH = "~/Library/Application Support/Anarlog/anarlog.sqlite";

export const ANARLOG_FOUND: AnarlogState = {
  detection: "found",
  storePath: ANARLOG_STORE_PATH,
  schemaVersion: 4,
};

/** Absent, but we still say where we looked. */
export const ANARLOG_NOT_FOUND: AnarlogState = {
  detection: "notFound",
  storePath: ANARLOG_STORE_PATH,
  schemaVersion: null,
};

/** Found and refused: the reader pins a ceiling rather than guess at v9. */
export const ANARLOG_UNSUPPORTED_SCHEMA: AnarlogState = {
  detection: "unsupportedSchema",
  storePath: ANARLOG_STORE_PATH,
  schemaVersion: 9,
};
