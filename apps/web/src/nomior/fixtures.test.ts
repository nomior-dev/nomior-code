import { describe, expect, it } from "vite-plus/test";

import { createFixtureNomiorPort } from "./fixtures";

describe("fixture port", () => {
  it("marks itself as fixture data", () => {
    expect(createFixtureNomiorPort().isFixture).toBe(true);
  });

  it("pinning moves the pin and explains the decision", async () => {
    const port = createFixtureNomiorPort();
    await port.setInstancePinned("inst-codex-main", true);
    const instances = await port.listInstances();
    expect(instances.filter((instance) => instance.pinned).map((instance) => instance.id)).toEqual([
      "inst-codex-main",
    ]);
    const scheduler = await port.getSchedulerState();
    expect(scheduler.lastDecision?.instanceId).toBe("inst-codex-main");
    expect(scheduler.lastDecision?.reason).toContain("Pinned manually");
  });

  it("unpinning drops the manual-pin decision instead of leaving it stale", async () => {
    const port = createFixtureNomiorPort();
    await port.setInstancePinned("inst-codex-main", true);
    await port.setInstancePinned("inst-codex-main", false);
    const instances = await port.listInstances();
    expect(instances.some((instance) => instance.pinned)).toBe(false);
    const scheduler = await port.getSchedulerState();
    expect(scheduler.lastDecision?.reason).not.toContain("Pinned manually");
    // Falls back to the strongest remaining signal: highest headroom.
    expect(scheduler.lastDecision?.instanceId).toBe("inst-claude-main");
  });

  it("resolving a memory candidate updates its status", async () => {
    const port = createFixtureNomiorPort();
    await port.resolveMemoryCandidate("mem-501", "approved");
    const candidates = await port.listMemoryCandidates();
    expect(candidates.find((candidate) => candidate.id === "mem-501")?.status).toBe("approved");
    expect(candidates.find((candidate) => candidate.id === "mem-502")?.status).toBe("pending");
  });
});
