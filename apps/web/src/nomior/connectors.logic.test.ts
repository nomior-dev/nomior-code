import { describe, expect, it } from "vite-plus/test";

import {
  GOOGLE_CLIENT_CONFIGURED,
  GOOGLE_CLIENT_OPERATOR,
  GOOGLE_CLIENT_UNCONFIGURED,
} from "./fixtures.connectors";
import {
  accountsSignature,
  authorizationUrlToOpen,
  clientIdHintLabel,
  clientIdSaveIntent,
  connectBlockedReason,
  connectorKindLabel,
  formatIngestedCount,
  formatLastSynced,
  needsGoogleSetup,
  orderAccounts,
  showsDetail,
  statusPresentation,
} from "./connectors.logic";
import type { ConnectorAccountItem } from "./types";

const account = (
  overrides: Partial<ConnectorAccountItem> & Pick<ConnectorAccountItem, "id">,
): ConnectorAccountItem => ({
  projectId: null,
  kind: "googleCalendar",
  displayName: overrides.id,
  status: "connected",
  lastSyncedAt: null,
  detail: null,
  ...overrides,
});

describe("connector kinds", () => {
  it("names each kind", () => {
    expect(connectorKindLabel("googleCalendar")).toBe("Google Calendar");
    expect(connectorKindLabel("gmail")).toBe("Gmail");
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
      account({ id: "2", kind: "gmail", displayName: "zoe@example" }),
      account({ id: "1", kind: "googleCalendar", displayName: "work@example" }),
      account({ id: "0", kind: "googleCalendar", displayName: "personal@example" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["0", "1", "2"]);
  });
});

describe("google client id", () => {
  it("renders the hint and never a whole id", () => {
    expect(clientIdHintLabel(GOOGLE_CLIENT_OPERATOR)).toBe("Client id ending 7t2v");
    expect(clientIdHintLabel(GOOGLE_CLIENT_UNCONFIGURED)).toBe("No client id yet");
    expect(
      clientIdHintLabel({ configured: true, source: "operator", clientIdHint: null }),
    ).toContain("did not report");
  });

  it("says when the id in use is the one the build ships with", () => {
    // Nothing to set up, and nothing the user chose: the label has to be able
    // to say so, or Advanced reads as a step somebody skipped.
    expect(clientIdHintLabel(GOOGLE_CLIENT_CONFIGURED)).toContain("Built-in");
  });

  it("treats an empty box as a clear only when there is something to clear", () => {
    expect(
      clientIdSaveIntent("  abc.apps.googleusercontent.com ", GOOGLE_CLIENT_UNCONFIGURED),
    ).toBe("save");
    expect(clientIdSaveIntent("   ", GOOGLE_CLIENT_OPERATOR)).toBe("clear");
    expect(clientIdSaveIntent("", GOOGLE_CLIENT_UNCONFIGURED)).toBe("unchanged");
    // A bundled id is part of the build, so Save would have nothing to clear.
    expect(clientIdSaveIntent("", GOOGLE_CLIENT_CONFIGURED)).toBe("unchanged");
  });

  it("asks for a client id only from a build that has none of its own", () => {
    expect(needsGoogleSetup(GOOGLE_CLIENT_UNCONFIGURED)).toBe(true);
    expect(needsGoogleSetup(GOOGLE_CLIENT_CONFIGURED)).toBe(false);
    expect(needsGoogleSetup(GOOGLE_CLIENT_OPERATOR)).toBe(false);
  });
});

describe("connect availability", () => {
  const base = {
    google: GOOGLE_CLIENT_CONFIGURED,
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
    // And says where the field is: one line at the foot of the page.
    expect(reason).toContain("foot of this page");
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

describe("account signature", () => {
  it("changes when an account arrives, and when one first syncs", () => {
    const before = [account({ id: "google-work" })];
    const arrived = [...before, account({ id: "google-personal" })];
    const synced = [account({ id: "google-work", lastSyncedAt: "2026-08-29T09:00:00.000Z" })];
    expect(accountsSignature(arrived)).not.toBe(accountsSignature(before));
    expect(accountsSignature(synced)).not.toBe(accountsSignature(before));
    // Two reads of an unchanged list are equal, so the page stops re-reading.
    expect(accountsSignature(before)).toBe(accountsSignature([account({ id: "google-work" })]));
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
