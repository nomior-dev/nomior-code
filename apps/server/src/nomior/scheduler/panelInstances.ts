/**
 * The instances panel's rows: provider instances joined with the two things
 * the scheduler knows about them — the rate-limit signal the observer folded
 * from provider events, and whether the user pinned them.
 *
 * Pure by design: every input is an argument, so the mapping is testable
 * without a database and the caller decides where each input comes from.
 *
 * @module nomior/scheduler/panelInstances
 */
import type { NomiorInstanceHealth, NomiorProviderInstance } from "@t3tools/contracts";

import type { InstanceRateLimitState } from "./Schemas.ts";

export interface PanelInstanceInput {
  readonly id: string;
  readonly label: string;
  /** Provider name as the panel shows it (Claude, Codex, …). */
  readonly provider: string;
  /**
   * False when the instance has no usable credential. Sign-in is not a
   * rate-limit signal — the caller resolves it, this mapping only reads it.
   */
  readonly signedIn: boolean;
}

export interface PanelInstancesInput {
  readonly instances: ReadonlyArray<PanelInstanceInput>;
  readonly rateLimits: ReadonlyArray<InstanceRateLimitState>;
  readonly pinned: ReadonlySet<string>;
}

/**
 * A provider warning is pressure the user should see, so `warning` reads as
 * throttled rather than healthy. No signal at all is not pressure.
 */
const healthOf = (state: InstanceRateLimitState | undefined): NomiorInstanceHealth =>
  state === undefined || state.status === "ok" ? "healthy" : "throttled";

/**
 * Headroom in [0, 1]. A missing or unusable utilization is no signal, which is
 * not the same as full headroom, so it stays null.
 */
export const headroomOf = (usedPercent: number | null | undefined): number | null =>
  usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)
    ? null
    : Math.min(1, Math.max(0, 1 - usedPercent / 100));

export const toPanelInstances = (
  input: PanelInstancesInput,
): ReadonlyArray<NomiorProviderInstance> => {
  const byInstance = new Map<string, InstanceRateLimitState>(
    input.rateLimits.map((state) => [state.instanceId, state]),
  );
  return input.instances.map((instance) => {
    const state = byInstance.get(instance.id);
    return {
      id: instance.id,
      label: instance.label,
      provider: instance.provider,
      health: instance.signedIn ? healthOf(state) : "signed-out",
      pinned: input.pinned.has(instance.id),
      headroom: headroomOf(state?.usedPercent),
    };
  });
};
