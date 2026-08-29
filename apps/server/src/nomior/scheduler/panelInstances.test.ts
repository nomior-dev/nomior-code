import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { headroomOf, toPanelInstances } from "./panelInstances.ts";
import type { InstanceRateLimitState } from "./Schemas.ts";

const claudeDriver = ProviderDriverKind.make("claudeAgent");

const rateLimit = (
  instanceId: string,
  status: InstanceRateLimitState["status"],
  usedPercent: number | null,
): InstanceRateLimitState => ({
  instanceId: ProviderInstanceId.make(instanceId),
  provider: claudeDriver,
  status,
  usedPercent,
  resetsAt: null,
  observedAt: "2026-08-29T08:40:00.000Z",
});

const instance = (id: string, signedIn = true) => ({
  id,
  label: `Claude — ${id}`,
  provider: "Claude",
  signedIn,
});

describe("headroomOf", () => {
  const cases: ReadonlyArray<readonly [number | null | undefined, number | null, string]> = [
    [0, 1, "an untouched window is full headroom"],
    [28, 0.72, "ordinary utilization"],
    [100, 0, "an exhausted window"],
    [120, 0, "out of range above 100 clamps to none left"],
    [-10, 1, "out of range below 0 clamps to full"],
    [null, null, "no signal is not full headroom"],
    [undefined, null, "an instance that never reported"],
    [Number.NaN, null, "an unusable number is no signal"],
  ];

  for (const [usedPercent, expected, description] of cases) {
    it(description, () => {
      const headroom = headroomOf(usedPercent);
      if (expected === null) {
        expect(headroom).toBeNull();
        return;
      }
      expect(headroom).not.toBeNull();
      expect(headroom ?? 0).toBeCloseTo(expected, 10);
    });
  }
});

describe("toPanelInstances", () => {
  const cases: ReadonlyArray<
    readonly [InstanceRateLimitState["status"], "healthy" | "throttled", string]
  > = [
    ["ok", "healthy", "no pressure reads as healthy"],
    ["warning", "throttled", "a provider warning is pressure the user should see"],
    ["limited", "throttled", "a rejected request is throttled"],
  ];

  for (const [status, health, description] of cases) {
    it(description, () => {
      const rows = toPanelInstances({
        instances: [instance("main")],
        rateLimits: [rateLimit("main", status, 40)],
        pinned: new Set(),
      });
      expect(rows[0]?.health).toBe(health);
    });
  }

  it("reports a signed-out instance as signed out whatever the stale signal says", () => {
    const rows = toPanelInstances({
      instances: [instance("main", false)],
      rateLimits: [rateLimit("main", "ok", 10)],
      pinned: new Set(),
    });
    expect(rows[0]?.health).toBe("signed-out");
  });

  it("treats an instance with no rate-limit row as healthy with no headroom signal", () => {
    const rows = toPanelInstances({
      instances: [instance("quiet")],
      rateLimits: [],
      pinned: new Set(),
    });
    expect(rows[0]).toEqual({
      id: "quiet",
      label: "Claude — quiet",
      provider: "Claude",
      health: "healthy",
      pinned: false,
      headroom: null,
    });
  });

  it("carries the pin through and leaves unpinned instances alone", () => {
    const rows = toPanelInstances({
      instances: [instance("main"), instance("studio")],
      rateLimits: [rateLimit("main", "ok", 28), rateLimit("studio", "limited", 94)],
      pinned: new Set(["studio", "removed-instance"]),
    });

    expect(rows.map((row) => [row.id, row.pinned])).toEqual([
      ["main", false],
      ["studio", true],
    ]);
    expect(rows[1]?.headroom ?? 0).toBeCloseTo(0.06, 10);
  });

  it("keeps signals from other instances out of a row", () => {
    const rows = toPanelInstances({
      instances: [instance("main")],
      rateLimits: [rateLimit("studio", "limited", 94)],
      pinned: new Set(),
    });
    expect(rows[0]?.health).toBe("healthy");
    expect(rows[0]?.headroom).toBeNull();
  });
});
