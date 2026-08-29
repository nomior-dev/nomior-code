/**
 * Pure presentation logic for the connectors page.
 *
 * Connecting an account is the one flow on this surface that can fail for a
 * reason the user cannot see: this build carries no Google client id and none
 * has been set, the OAuth redirect lands on a loopback listener the viewing
 * browser cannot reach, or the Anarlog store is absent — or present and
 * deliberately refused. Every one of those turns into a sentence here rather
 * than into a greyed-out button, so a blocked Connect always says who has to
 * do what next.
 *
 * @module nomior/connectors.logic
 */
import { getRelativeTimeState } from "../timestampFormat";
import type { BadgeTone } from "./reviewBoard.logic";
import type {
  AnarlogState,
  ConnectorAccountItem,
  ConnectorKind,
  ConnectorStatus,
  GoogleClientState,
} from "./types";

export const NEVER_SYNCED_LABEL = "Never synced";

/** Section order on the page, and the sort key for the account list. */
export const CONNECTOR_KIND_ORDER: readonly ConnectorKind[] = [
  "googleCalendar",
  "gmail",
  "anarlog",
];

/** The kinds that go through Google's OAuth flow, and so need a client id. */
export function isGoogleConnector(kind: ConnectorKind): boolean {
  return kind === "googleCalendar" || kind === "gmail";
}

export function connectorKindLabel(kind: ConnectorKind): string {
  switch (kind) {
    case "googleCalendar":
      return "Google Calendar";
    case "gmail":
      return "Gmail";
    case "anarlog":
      return "Anarlog";
  }
}

/** What connecting this kind actually buys the user, in one line. */
export function connectorKindDescription(kind: ConnectorKind): string {
  switch (kind) {
    case "googleCalendar":
      return "Your events, so a recorded session can be matched to the meeting it was.";
    case "gmail":
      return "Your threads, so mail can be cited as context alongside meetings and reviews.";
    case "anarlog":
      return "Recorded sessions from the Anarlog store on this environment's machine.";
  }
}

export interface StatusPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
  /**
   * What the user does about it. Null while connected; otherwise it names the
   * difference between a failure that may clear and one that will not.
   */
  readonly recovery: string | null;
}

/**
 * `error` is transient and `revoked` is not, so they never share a tone: a
 * retry fixes the first and only reconnecting fixes the second.
 */
export function statusPresentation(status: ConnectorStatus): StatusPresentation {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "success", recovery: null };
    case "error":
      return {
        label: "Sync failed",
        tone: "warning",
        recovery: "This kind of failure often clears on its own. Sync again.",
      };
    case "revoked":
      return {
        label: "Access revoked",
        tone: "error",
        recovery: "Retrying will not help. Connect the account again to restore access.",
      };
  }
}

/** The server redacts `detail` before it ships; a connected account has none. */
export function showsDetail(account: ConnectorAccountItem): boolean {
  return account.status !== "connected" && account.detail !== null;
}

/**
 * Last sync, as a phrase. A never-synced account says so rather than showing a
 * blank, and a timestamp we cannot parse says that instead of reading as never.
 */
export function formatLastSynced(lastSyncedAt: string | null): string {
  const state = getRelativeTimeState(lastSyncedAt);
  switch (state.status) {
    case "missing":
      return NEVER_SYNCED_LABEL;
    case "invalid":
      return "Last sync time unknown";
    case "relative":
      return `Synced ${state.suffix === null ? state.value : `${state.value} ${state.suffix}`}`;
  }
}

/** Kind first, then name, so the list does not reshuffle between reads. */
export function orderAccounts(
  accounts: readonly ConnectorAccountItem[],
): readonly ConnectorAccountItem[] {
  return accounts.toSorted((left, right) => {
    const byKind =
      CONNECTOR_KIND_ORDER.indexOf(left.kind) - CONNECTOR_KIND_ORDER.indexOf(right.kind);
    return byKind !== 0 ? byKind : left.displayName.localeCompare(right.displayName);
  });
}

/** Only the last four characters ever reach the client, and only these render. */
export function clientIdHintLabel(google: GoogleClientState): string {
  if (!google.configured) return "No client id yet";
  const hint =
    google.clientIdHint === null
      ? "the server did not report which id"
      : `ending ${google.clientIdHint}`;
  return google.source === "bundled" ? `Built-in client id, ${hint}` : `Client id ${hint}`;
}

/**
 * Whether the setup fields open on their own. Only a build with no client id
 * of its own has a setup step left for the user, and only then is Advanced
 * something they have to find rather than something they may ignore.
 */
export function opensAdvancedByDefault(google: GoogleClientState): boolean {
  return google.source === "none";
}

export type ClientIdSaveIntent = "save" | "clear" | "unchanged";

/**
 * What pressing Save would do. An empty box means "clear", so the button says
 * `Clear` and the panel warns first rather than silently unconfiguring the
 * environment. Only an operator-set id can be cleared: a bundled one is part of
 * the build, and an empty box against it would be a button that does nothing.
 */
export function clientIdSaveIntent(input: string, google: GoogleClientState): ClientIdSaveIntent {
  if (input.trim().length > 0) return "save";
  return google.source === "operator" ? "clear" : "unchanged";
}

export interface AnarlogPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly detail: string;
}

/**
 * The three detections are three different facts and never collapse: absent,
 * present and readable, or present and refused. The last one matters most —
 * the reader pins a schema ceiling, so a newer store is found and left alone
 * rather than parsed on a guess.
 */
export function anarlogPresentation(state: AnarlogState): AnarlogPresentation {
  switch (state.detection) {
    case "found":
      return {
        label: "Store found",
        tone: "success",
        detail:
          state.storePath === null
            ? "Found an Anarlog store on this environment's machine, though it did not report a path."
            : `Reading ${state.storePath} on this environment's machine.`,
      };
    case "notFound":
      return {
        label: "No store",
        tone: "secondary",
        detail:
          state.storePath === null
            ? "We looked in Anarlog's default location on this environment's machine and found no store. Record a session in Anarlog, then check again."
            : `We looked at ${state.storePath} on this environment's machine and found no store there.`,
      };
    case "unsupportedSchema": {
      const version =
        state.schemaVersion === null ? "an unrecognised version" : `v${state.schemaVersion}`;
      const where = state.storePath === null ? "A store" : `The store at ${state.storePath}`;
      return {
        label: "Schema too new",
        tone: "warning",
        detail: `${where} reports schema ${version}, past the ceiling this reader was built against. Nomior leaves it alone rather than misreading it — upgrade Nomior, or keep using the Anarlog version that wrote it.`,
      };
    }
  }
}

export interface ConnectAvailabilityInput {
  readonly kind: ConnectorKind;
  readonly google: GoogleClientState;
  readonly anarlog: AnarlogState;
  readonly accounts: readonly ConnectorAccountItem[];
  readonly canStartLocalOAuth: boolean;
}

/**
 * Why Connect cannot run, or null when it can.
 *
 * The loopback check comes first for the Google kinds: it is the only blocker
 * the person at this screen cannot clear from this screen, so naming a second,
 * fixable reason ahead of it would imply that fixing it would be enough.
 * Anarlog is never gated on it — nothing about reading a local SQLite file
 * involves a browser redirect.
 */
export function connectBlockedReason(input: ConnectAvailabilityInput): string | null {
  const { kind, google, anarlog, accounts, canStartLocalOAuth } = input;

  if (isGoogleConnector(kind)) {
    if (!canStartLocalOAuth) {
      return "Google sign-in finishes on a loopback address on this environment's machine, which this browser cannot reach. Open Nomior Code on that machine to connect.";
    }
    if (!google.configured) {
      return "This build ships no Google client id. Add one under Advanced first.";
    }
    return null;
  }

  // Detection is checked before the existing account: a row connected from a
  // store that has since moved must not report itself as already connected,
  // which would leave Connect blocked by the very thing it would fix.
  switch (anarlog.detection) {
    case "notFound":
      return "There is no Anarlog store to connect on this environment's machine yet.";
    case "unsupportedSchema":
      return "This Anarlog store's schema is newer than the reader supports, so connecting it would read it wrong.";
    case "found":
      return accounts.some((account) => account.kind === "anarlog")
        ? "The Anarlog store on this machine is already connected."
        : null;
  }
}

/**
 * The authorization URL, if the server handed back something a browser can
 * actually open. `connectConnector` resolves to a server-supplied string that
 * goes straight to the shell, so anything that is not an absolute http(s) URL
 * — a relative path, a `javascript:` payload, an empty string from a connector
 * with no browser step — is refused rather than opened.
 */
export function authorizationUrlToOpen(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
}

/**
 * What the account list looks like right now, as one comparable string.
 *
 * The page watches for a connection it cannot see land — the sign-in finishes
 * in a browser, the first sync finishes on the server — and this is how it
 * tells "nothing yet" from "something changed" without re-rendering on every
 * poll. Both ids and sync times are in it, so a new account and a first sync
 * of an existing one are each a change.
 */
export function accountsSignature(accounts: readonly ConnectorAccountItem[]): string {
  return accounts
    .map((account) => `${account.id}:${account.status}:${account.lastSyncedAt ?? ""}`)
    .join("|");
}

/** Sync's result, said in words. Zero is a real answer, not a failure. */
export function formatIngestedCount(ingested: number): string {
  if (!Number.isFinite(ingested) || ingested < 0) return "Synced.";
  if (ingested === 0) return "Synced. Nothing new to ingest.";
  return `Synced. ${ingested} ${ingested === 1 ? "source" : "sources"} written or refreshed.`;
}
