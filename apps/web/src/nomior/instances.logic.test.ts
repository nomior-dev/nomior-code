import { describe, expect, it } from "vite-plus/test";

import { createFixtureNomiorPort } from "./fixtures";
import {
  applyPin,
  canPin,
  describeDecision,
  formatHeadroom,
  healthPresentation,
} from "./instances.logic";
import type { ProviderInstanceItem } from "./types";

const instance = (overrides: Partial<ProviderInstanceItem>): ProviderInstanceItem => ({
  id: "inst-1",
  label: "Claude — main",
  provider: "Claude",
  health: "healthy",
  pinned: false,
  headroom: 0.5,
  ...overrides,
});

describe("healthPresentation", () => {
  it("maps each health state to a distinct tone", () => {
    expect(healthPresentation("healthy")).toEqual({ label: "Healthy", tone: "success" });
    expect(healthPresentation("throttled")).toEqual({ label: "Throttled", tone: "warning" });
    expect(healthPresentation("signed-out")).toEqual({ label: "Signed out", tone: "error" });
  });
});

describe("formatHeadroom", () => {
  it("renders a percentage or an honest no-signal label", () => {
    expect(formatHeadroom(0.72)).toBe("72% headroom");
    expect(formatHeadroom(null)).toBe("No signal yet");
  });
});

describe("describeDecision", () => {
  it("names the picked instance and keeps the reason verbatim", () => {
    const instances = [instance({ id: "inst-a", label: "Claude — main" })];
    const described = describeDecision(
      { instanceId: "inst-a", reason: "Highest headroom.", decidedAt: "2026-08-29T10:00:00.000Z" },
      instances,
    );
    expect(described).toEqual({ instanceLabel: "Claude — main", reason: "Highest headroom." });
  });

  it("falls back to the raw id for a removed instance and to null without a decision", () => {
    expect(
      describeDecision(
        { instanceId: "gone", reason: "r", decidedAt: "2026-08-29T10:00:00.000Z" },
        [],
      )?.instanceLabel,
    ).toBe("gone");
    expect(describeDecision(null, [])).toBeNull();
  });
});

describe("applyPin", () => {
  it("pins one instance and unpins every other", () => {
    const list = [instance({ id: "a", pinned: true }), instance({ id: "b" })];
    const pinned = applyPin(list, "b", true);
    expect(pinned.map((entry) => entry.pinned)).toEqual([false, true]);
  });
});

describe("canPin", () => {
  it("refuses signed-out instances", () => {
    expect(canPin(instance({ health: "signed-out" }))).toBe(false);
    expect(canPin(instance({ health: "throttled" }))).toBe(true);
  });
});

describe("fixture port — scheduler", () => {
  it("explains a manual pin in the last decision", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    await port.setInstancePinned("inst-codex-main", true);
    const scheduler = await port.getSchedulerState();
    expect(scheduler.lastDecision?.instanceId).toBe("inst-codex-main");
    expect(scheduler.lastDecision?.reason).toContain("Pinned manually");
    const instances = await port.listInstances();
    expect(instances.filter((entry) => entry.pinned)).toHaveLength(1);
  });

  it("persists the advisory-mode toggle", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    await port.setAdvisoryMode(false);
    expect((await port.getSchedulerState()).advisoryMode).toBe(false);
  });
});
