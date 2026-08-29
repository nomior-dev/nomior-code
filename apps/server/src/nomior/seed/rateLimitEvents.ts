/**
 * rateLimitEvents - synthetic `account.rate-limits.updated` events.
 *
 * The scheduler's only input is the rate-limit signal the provider CLIs
 * already emit, so seeding and simulating instance pressure means emitting
 * those events — not writing the observer's table behind its back. These
 * builders produce exactly the payload shapes `normalizeRateLimitEvent`
 * parses (Claude `rate_limit_event`, Codex `account/rateLimits/updated`).
 *
 * @module nomior/seed/rateLimitEvents
 */
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import type { SeedProviderInstance } from "./scenario.ts";

/** Thread the synthetic events are attributed to; never a real conversation. */
const SEED_THREAD_ID = ThreadId.make("nomior-seed");

const epochSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export interface RateLimitEventInput {
  readonly eventId: string;
  readonly instanceId: string;
  readonly driverKind: string;
  readonly status: "ok" | "warning" | "limited";
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

const claudePayload = (input: RateLimitEventInput): Record<string, unknown> => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status:
      input.status === "limited"
        ? "rejected"
        : input.status === "warning"
          ? "allowed_warning"
          : "allowed",
    ...(input.usedPercent === null ? {} : { utilization: input.usedPercent }),
    ...(input.resetsAt === null ? {} : { resetsAt: epochSeconds(input.resetsAt) }),
  },
});

const codexPayload = (input: RateLimitEventInput): Record<string, unknown> => ({
  rateLimits: {
    primary: {
      // Codex reports windows, not a status: a limited window is a full one.
      usedPercent: input.status === "limited" ? 100 : (input.usedPercent ?? 0),
      resetsAt: input.resetsAt === null ? null : epochSeconds(input.resetsAt),
    },
  },
});

export const rateLimitEvent = (input: RateLimitEventInput): ProviderRuntimeEvent => ({
  eventId: EventId.make(input.eventId),
  provider: ProviderDriverKind.make(input.driverKind),
  providerInstanceId: ProviderInstanceId.make(input.instanceId),
  threadId: SEED_THREAD_ID,
  createdAt: input.observedAt,
  type: "account.rate-limits.updated",
  payload: {
    rateLimits: input.driverKind === "codex" ? codexPayload(input) : claudePayload(input),
  },
});

/**
 * The events that put a seeded instance into the state the scenario claims.
 * A signed-out instance emits nothing — nobody is running it, so there is no
 * signal, and "no signal" is not the same as "full headroom".
 */
export const seedRateLimitEvents = (
  instances: ReadonlyArray<SeedProviderInstance>,
): ReadonlyArray<ProviderRuntimeEvent> =>
  instances.flatMap((instance, index) =>
    instance.rateLimitStatus === null
      ? []
      : [
          rateLimitEvent({
            eventId: `nomior-seed-rl-${index + 1}`,
            instanceId: instance.instanceId,
            driverKind: instance.driverKind,
            status: instance.rateLimitStatus,
            usedPercent: instance.usedPercent,
            resetsAt: instance.resetsAt,
            observedAt: instance.observedAt,
          }),
        ],
  );
