import { describe, expect, it } from "vite-plus/test";

import {
  ANARLOG_FOUND,
  ANARLOG_NOT_FOUND,
  ANARLOG_STORE_PATH,
  ANARLOG_UNSUPPORTED_SCHEMA,
  GOOGLE_CLIENT_CONFIGURED,
  GOOGLE_CLIENT_UNCONFIGURED,
} from "./fixtures.connectors";
import {
  anarlogPresentation,
  authorizationUrlToOpen,
  clientIdHintLabel,
  clientIdSaveIntent,
  connectBlockedReason,
  connectorKindLabel,
  formatIngestedCount,
  formatLastSynced,
  isGoogleConnector,
  orderAccounts,
  showsDetail,
  statusPresentation,
} from "./connectors.logic";
import type { ConnectorAccountItem } from "./types";

const account = (
  overrides: Partial<ConnectorAccountItem> & Pick<ConnectorAccountItem, "id">,
): ConnectorAccountItem => ({
  kind: "googleCalendar",
  displayName: overrides.id,
  status: "connected",
  lastSyncedAt: null,
  detail: null,
  ...overrides,
});

describe("connector kinds", () => {
  it("names each kind and knows which ones need Google's OAuth flow", () => {
    expect(connectorKindLabel("googleCalendar")).toBe("Google Calendar");
    expect(connectorKindLabel("gmail")).toBe("Gmail");
    expect(connectorKindLabel("anarlog")).toBe("Anarlog");
    expect(isGoogleConnector("googleCalendar")).toBe(true);
    expect(isGoogleConnector("gmail")).toBe(true);
    expect(isGoogleConnector("anarlog")).toBe(false);
  });
});

describe("account status", () => {
  it("keeps a retryable failure and a revoked account apart", () => {
    const error = statusPresentation("error");
    const revoked = statusPresentation("revoked");
    expect(error.label).not.toBe(revoked.label);
    expect(error.tone).not.toBe(revoked.tone);
    expect(error.recovery).toContain("Sync again");
    expect(revoked.recovery).toContain("Connect the account again");
    expect(statusPresentation("connected").recovery).toBeNull();
  });

  it("shows the redacted detail only where there is a failure to explain", () => {
    expect(showsDetail(account({ id: "a", status: "error", detail: "429 from Google" }))).toBe(
      true,
    );
    expect(showsDetail(account({ id: "b", status: "revoked", detail: "token revoked" }))).toBe(
      true,
    );
    // A connected account carrying stale detail would read as a live problem.
    expect(showsDetail(account({ id: "c", status: "connected", detail: "429 from Google" }))).toBe(
      false,
    );
    expect(showsDetail(account({ id: "d", status: "error", detail: null }))).toBe(false);
  });
});

describe("last sync", () => {
  it("says never rather than leaving a blank", () => {
    expect(formatLastSynced(null)).toBe("Never synced");
  });

  it("does not pass an unreadable timestamp off as never synced", () => {
    expect(formatLastSynced("not a timestamp")).toBe("Last sync time unknown");
  });

  it("reads as a phrase for a real timestamp", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatLastSynced(twoHoursAgo)).toBe("Synced 2h ago");
  });
});

describe("account ordering", () => {
  it("groups by kind then name, so the list does not reshuffle between reads", () => {
    const ordered = orderAccounts([
      account({ id: "3", kind: "anarlog", displayName: "Anarlog" }),
      account({ id: "2", kind: "gmail", displayName: "zoe@example" }),
      account({ id: "1", kind: "googleCalendar", displayName: "work@example" }),
      account({ id: "0", kind: "googleCalendar", displayName: "personal@example" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["0", "1", "2", "3"]);
  });
});

describe("google client id", () => {
  it("renders the hint and never a whole id", () => {
    expect(clientIdHintLabel(GOOGLE_CLIENT_CONFIGURED)).toBe("Client id ending j4kq");
    expect(clientIdHintLabel(GOOGLE_CLIENT_UNCONFIGURED)).toBe("No client id yet");
    expect(clientIdHintLabel({ configured: true, clientIdHint: null })).toContain("did not report");
  });

  it("treats an empty box as a clear only when there is something to clear", () => {
    expect(
      clientIdSaveIntent("  abc.apps.googleusercontent.com ", GOOGLE_CLIENT_UNCONFIGURED),
    ).toBe("save");
    expect(clientIdSaveIntent("   ", GOOGLE_CLIENT_CONFIGURED)).toBe("clear");
    expect(clientIdSaveIntent("", GOOGLE_CLIENT_UNCONFIGURED)).toBe("unchanged");
  });
});

describe("anarlog detection", () => {
  it("says three different things for three different facts", () => {
    const found = anarlogPresentation(ANARLOG_FOUND);
    const missing = anarlogPresentation(ANARLOG_NOT_FOUND);
    const refused = anarlogPresentation(ANARLOG_UNSUPPORTED_SCHEMA);
    expect(new Set([found.detail, missing.detail, refused.detail]).size).toBe(3);
    expect(found.detail).toContain(ANARLOG_STORE_PATH);
    // We looked, and we say where.
    expect(missing.detail).toContain(ANARLOG_STORE_PATH);
    expect(missing.detail).toContain("no store");
    // Found and refused, with the version that caused the refusal named.
    expect(refused.detail).toContain("v9");
    expect(refused.detail).toContain(ANARLOG_STORE_PATH);
  });

  it("still explains itself when the server reported no path or version", () => {
    const missing = anarlogPresentation({
      detection: "notFound",
      storePath: null,
      schemaVersion: null,
    });
    expect(missing.detail).toContain("default location");
    const refused = anarlogPresentation({
      detection: "unsupportedSchema",
      storePath: null,
      schemaVersion: null,
    });
    expect(refused.detail).toContain("unrecognised version");
  });
});

describe("connect availability", () => {
  const base = {
    google: GOOGLE_CLIENT_CONFIGURED,
    anarlog: ANARLOG_FOUND,
    accounts: [] as readonly ConnectorAccountItem[],
    canStartLocalOAuth: true,
  };

  it("lets a configured Google connector through on the server's own machine", () => {
    expect(connectBlockedReason({ ...base, kind: "googleCalendar" })).toBeNull();
    expect(connectBlockedReason({ ...base, kind: "gmail" })).toBeNull();
  });

  it("names the missing client id as the setup step it is", () => {
    const reason = connectBlockedReason({
      ...base,
      kind: "gmail",
      google: GOOGLE_CLIENT_UNCONFIGURED,
    });
    expect(reason).toContain("client id");
    expect(reason).toContain("no bundled one");
  });

  it("blocks a remote client on the loopback redirect, ahead of any fixable reason", () => {
    const reason = connectBlockedReason({
      ...base,
      kind: "googleCalendar",
      google: GOOGLE_CLIENT_UNCONFIGURED,
      canStartLocalOAuth: false,
    });
    expect(reason).toContain("loopback");
    // Naming the client id here would imply pasting one is enough. It is not.
    expect(reason).not.toContain("client id");
  });

  it("does not gate anarlog on the OAuth redirect, which it never uses", () => {
    expect(
      connectBlockedReason({ ...base, kind: "anarlog", canStartLocalOAuth: false }),
    ).toBeNull();
  });

  it("blocks anarlog when there is no store, or one we refuse to read", () => {
    expect(
      connectBlockedReason({ ...base, kind: "anarlog", anarlog: ANARLOG_NOT_FOUND }),
    ).toContain("no Anarlog store");
    expect(
      connectBlockedReason({ ...base, kind: "anarlog", anarlog: ANARLOG_UNSUPPORTED_SCHEMA }),
    ).toContain("newer than the reader supports");
  });

  it("blocks a second anarlog connection: one machine has one store", () => {
    expect(
      connectBlockedReason({
        ...base,
        kind: "anarlog",
        accounts: [account({ id: "anarlog-local", kind: "anarlog" })],
      }),
    ).toContain("already connected");
  });
});

describe("authorization url", () => {
  it("passes an absolute http(s) url through untouched", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz";
    expect(authorizationUrlToOpen(url)).toBe(url);
    expect(authorizationUrlToOpen("http://127.0.0.1:8931/oauth/start")).toBe(
      "http://127.0.0.1:8931/oauth/start",
    );
  });

  it("refuses anything the shell should not be handed", () => {
    expect(authorizationUrlToOpen("")).toBeNull();
    expect(authorizationUrlToOpen("   ")).toBeNull();
    expect(authorizationUrlToOpen("/oauth/start")).toBeNull();
    expect(authorizationUrlToOpen("javascript:alert(1)")).toBeNull();
    expect(authorizationUrlToOpen("file:///etc/passwd")).toBeNull();
  });
});

describe("sync result", () => {
  it("reports a real zero instead of implying a failure", () => {
    expect(formatIngestedCount(0)).toContain("Nothing new");
    expect(formatIngestedCount(1)).toContain("1 source ");
    expect(formatIngestedCount(12)).toContain("12 sources");
    expect(formatIngestedCount(Number.NaN)).toBe("Synced.");
  });
});
