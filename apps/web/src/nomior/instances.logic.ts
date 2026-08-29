/**
 * Pure presentation logic for the instances panel.
 *
 * @module nomior/instances.logic
 */
import type { BadgeTone } from "./reviewBoard.logic";
import type { InstanceHealth, ProviderInstanceItem, SchedulerDecision } from "./types";

export interface HealthPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
}

export function healthPresentation(health: InstanceHealth): HealthPresentation {
  switch (health) {
    case "healthy":
      return { label: "Healthy", tone: "success" };
    case "throttled":
      return { label: "Throttled", tone: "warning" };
    case "signed-out":
      return { label: "Signed out", tone: "error" };
  }
}

export function formatHeadroom(headroom: number | null): string {
  if (headroom === null) return "No signal yet";
  return `${Math.round(headroom * 100)}% headroom`;
}

/**
 * The scheduler's last decision, named after the instance it picked. Falls
 * back to the raw id when the instance has since been removed.
 */
export function describeDecision(
  decision: SchedulerDecision | null,
  instances: readonly ProviderInstanceItem[],
): { instanceLabel: string; reason: string } | null {
  if (decision === null) return null;
  const instance = instances.find((candidate) => candidate.id === decision.instanceId);
  return {
    instanceLabel: instance?.label ?? decision.instanceId,
    reason: decision.reason,
  };
}

/** Only one instance can be pinned; pinning one unpins the rest. */
export function applyPin(
  instances: readonly ProviderInstanceItem[],
  id: string,
  pinned: boolean,
): readonly ProviderInstanceItem[] {
  return instances.map((instance) =>
    instance.id === id ? { ...instance, pinned } : { ...instance, pinned: false },
  );
}

/** A signed-out instance cannot be pinned: the scheduler could never honor it. */
export function canPin(instance: ProviderInstanceItem): boolean {
  return instance.health !== "signed-out";
}
