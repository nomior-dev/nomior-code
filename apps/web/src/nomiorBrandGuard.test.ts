import type { DesktopUpdateState } from "@t3tools/contracts";
import { containsUpstreamBranding } from "@t3tools/shared/nomiorBrand";
import { describe, expect, it } from "vite-plus/test";

import { APP_BASE_NAME, APP_DISPLAY_NAME } from "./branding";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateInstallConfirmationMessage,
} from "./components/desktopUpdate.logic";
import { clientPresentationMetadata } from "./connection/clientMetadata";

// Regression tripwire for the rebrand: the display constants and the copy
// derived from them must never regress to upstream's "T3 Code". Deliberately
// unrebranded surfaces (T3 Connect, T3 Chat theme, strings naming the mobile
// app or the `t3` server CLI) are out of scope here — see the "Branding
// boundary" section of docs/nomior/FORK-MANIFEST.md.

const browserIdentity = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  platform: "Win32",
  maxTouchPoints: 0,
};

const arm64IntelState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "x64",
  runningUnderArm64Translation: true,
  availableVersion: "1.1.0",
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("nomior brand guard", () => {
  it("keeps the app name constants free of upstream marks", () => {
    expect(containsUpstreamBranding(APP_BASE_NAME)).toBe(false);
    expect(containsUpstreamBranding(APP_DISPLAY_NAME)).toBe(false);
  });

  it("keeps client presentation labels free of upstream marks", () => {
    const web = clientPresentationMetadata({
      appVersion: "1.2.3",
      hosted: false,
      identity: browserIdentity,
      desktopBridge: undefined,
    });
    expect(web.label).toBeDefined();
    expect(containsUpstreamBranding(web.label ?? "")).toBe(false);
  });

  it("keeps desktop update copy free of upstream marks", () => {
    expect(containsUpstreamBranding(getArm64IntelBuildWarningDescription(arm64IntelState))).toBe(
      false,
    );
    expect(
      containsUpstreamBranding(getDesktopUpdateInstallConfirmationMessage(arm64IntelState)),
    ).toBe(false);
  });
});
