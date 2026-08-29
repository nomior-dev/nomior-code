/**
 * Pure presentation logic for the connectors page.
 *
 * Connecting an account is the one flow on this surface that can fail for a
 * reason the user cannot see: this build carries no Google client id and none
 * has been set, or the OAuth redirect lands on a loopback listener the viewing
 * browser cannot reach. Both turn into a sentence here rather than into a
 * greyed-out button, so a blocked Connect always says who has to do what next.
 *
 * @module nomior/connectors.logic
 */
import { getRelativeTimeState } from "../timestampFormat";
import type { BadgeTone } from "./reviewBoard.logic";
import type {
  ConnectorAccountItem,
  ConnectorKind,
  ConnectorStatus,
  GoogleClientState,
} from "./types";

export const NEVER_SYNCED_LABEL = "Never synced";

/** Section order on the page, and the sort key for the account list. */
export const CONNECTOR_KIND_ORDER: readonly ConnectorKind[] = ["googleCalendar", "gmail"];

export function connectorKindLabel(kind: ConnectorKind): string {
  switch (kind) {
    case "googleCalendar":
      return "Google Calendar";
    case "gmail":
      return "Gmail";
  }
}

/** What connecting this kind actually buys the user, in one line. */
export function connectorKindDescription(kind: ConnectorKind): string {
  switch (kind) {
    case "googleCalendar":
      return "Your events, so a recorded session can be matched to the meeting it was.";
    case "gmail":
      return "Your threads, so mail can be cited as context alongside meetings and reviews.";
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

/** The accounts one connector owns, in a stable order. */
export function accountsOfKind(
  accounts: readonly ConnectorAccountItem[],
  kind: ConnectorKind,
): readonly ConnectorAccountItem[] {
  return accounts
    .filter((account) => account.kind === kind)
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * What the row's own button says.
 *
 * Connecting a second account is the same press as the first — Google's own
 * chooser decides which — so the label is the only thing that changes, to the
 * thing the press actually does.
 */
export function connectActionLabel(connected: number): string {
  return connected === 0 ? "Connect" : "Add account";
}

export type ConnectorRowStatus = "connected" | "attention" | "none";

/**
 * One glyph per connector, from the accounts under it: a tick once something
 * is signed in, a warning the moment any of them stops working, and a dash
 * when there is nothing there. The row says which of the three it is before
 * anyone reads a word of it.
 */
export function connectorRowStatus(
  accounts: readonly ConnectorAccountItem[],
  kind: ConnectorKind,
): ConnectorRowStatus {
  const own = accounts.filter((account) => account.kind === kind);
  if (own.length === 0) return "none";
  return own.some((account) => account.status !== "connected") ? "attention" : "connected";
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
 * Whether this environment has a setup step left before anything can connect.
 *
 * The client id is the page's only piece of configuration, and a build that
 * carries one has none: the field is not tucked away for that case, it is not
 * rendered at all.
 */
export function needsGoogleSetup(google: GoogleClientState): boolean {
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

export interface ConnectAvailabilityInput {
  readonly kind: ConnectorKind;
  readonly google: GoogleClientState;
  readonly accounts: readonly ConnectorAccountItem[];
  readonly canStartLocalOAuth: boolean;
}

/**
 * Why Connect cannot run, or null when it can.
 *
 * The loopback check comes first: it is the only blocker the person at this
 * screen cannot clear from this screen, so naming a second, fixable reason
 * ahead of it would imply that fixing it would be enough.
 */
export function connectBlockedReason(input: ConnectAvailabilityInput): string | null {
  if (!input.canStartLocalOAuth) {
    return "Google sign-in finishes on a loopback address on this environment's machine, which this browser cannot reach. Open Nomior Code on that machine to connect.";
  }
  if (!input.google.configured) {
    return "This build has no Google client id. Add one at the foot of this page.";
  }
  return null;
}

/**
 * The one line under a connector's name, or null when the row says enough.
 *
 * A row earns at most one sentence. Once a connector has accounts the rows
 * beneath it are the sentence, so it gets none. An unconnected row carries
 * what connecting would buy you — unless the thing stopping it is one of the
 * two blockers the page states once elsewhere, and then repeating it here
 * would be the same sentence twice.
 */
export function connectorRowLine(input: ConnectAvailabilityInput): string | null {
  if (accountsOfKind(input.accounts, input.kind).length > 0) return null;
  if (!input.canStartLocalOAuth || !input.google.configured) return null;
  return connectorKindDescription(input.kind);
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
