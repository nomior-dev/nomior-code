import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  DEFAULT_NOMIOR_SCHEDULER_SETTINGS,
  instanceHeadroom,
  type InstanceRateLimitState,
} from "./Schemas.ts";

const state = (overrides: Partial<InstanceRateLimitState>): InstanceRateLimitState => ({
  instanceId: ProviderInstanceId.make("claude-work"),
  provider: ProviderDriverKind.make("claudeAgent"),
  status: "ok",
  usedPercent: null,
  resetsAt: null,
  observedAt: "2026-08-29T10:00:00.000Z",
  ...overrides,
});

describe("NomiorSchedulerSettings", () => {
  it("is opt-in: the scheduler is off by default", () => {
    assert.isFalse(DEFAULT_NOMIOR_SCHEDULER_SETTINGS.enabled);
    assert.deepStrictEqual(DEFAULT_NOMIOR_SCHEDULER_SETTINGS.pinnedInstanceByProject, {});
    assert.deepStrictEqual(DEFAULT_NOMIOR_SCHEDULER_SETTINGS.allowedInstancesByProject, {});
    assert.isTrue(DEFAULT_NOMIOR_SCHEDULER_SETTINGS.stickyByProject);
  });
});

describe("instanceHeadroom", () => {
  it("treats unknown utilization as full headroom", () => {
    assert.strictEqual(instanceHeadroom(state({})), 100);
  });

  it("derives headroom from the reported utilization", () => {
    assert.strictEqual(instanceHeadroom(state({ usedPercent: 80, status: "warning" })), 20);
  });

  it("reports zero headroom for a limited instance regardless of utilization", () => {
    assert.strictEqual(instanceHeadroom(state({ status: "limited", usedPercent: 40 })), 0);
  });
});
