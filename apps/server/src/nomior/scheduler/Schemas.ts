/**
 * Shared shapes for the Nomior instance scheduler.
 *
 * The scheduler is advisory by construction: it consumes only the
 * credential-free rate-limit signals the provider adapters already emit
 * (`account.rate-limits.updated` runtime events) and never reads tokens,
 * home directories, or usage endpoints.
 */
import { IsoDateTime, ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Normalized availability of one provider instance, derived from the last
 * observed rate-limit event.
 *
 * - `ok`: no pressure signal.
 * - `warning`: provider warned (Claude `allowed_warning`, Codex window near
 *   exhaustion).
 * - `limited`: provider rejected or a window is exhausted.
 */
export const InstanceRateLimitStatus = Schema.Literals(["ok", "warning", "limited"]);
export type InstanceRateLimitStatus = typeof InstanceRateLimitStatus.Type;

export const InstanceRateLimitState = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  status: InstanceRateLimitStatus,
  /** 0..100 of the most constrained window, when the provider reported one. */
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  observedAt: IsoDateTime,
});
export type InstanceRateLimitState = typeof InstanceRateLimitState.Type;

/** Headroom in percent. Unknown utilization counts as full headroom. */
export const instanceHeadroom = (state: InstanceRateLimitState): number =>
  state.status === "limited" ? 0 : 100 - (state.usedPercent ?? 0);

/**
 * Scheduler settings. Deliberately additive: this schema lives in the Nomior
 * layer and is wired into `ServerSettings` by a single registration line.
 * The feature is opt-in — `enabled` defaults to false and a disabled
 * scheduler never produces a choice.
 */
export const NomiorSchedulerSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Manual per-project pin. Highest priority; always honored when present. */
  pinnedInstanceByProject: Schema.Record(ProjectId, ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Hard project constraint: when a project lists instances here, only those
   * instances may be chosen for it (e.g. "this client's repo only ever runs
   * on the work account"). Manual pins outrank it: an explicit per-thread
   * request or `pinnedInstanceByProject` entry is honored even outside this
   * list — a settings UI should warn when a pin contradicts the constraint.
   */
  allowedInstancesByProject: Schema.Record(ProjectId, Schema.Array(ProviderInstanceId)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Prefer the instance this project used last, while it has headroom. */
  stickyByProject: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type NomiorSchedulerSettings = typeof NomiorSchedulerSettings.Type;

export const DEFAULT_NOMIOR_SCHEDULER_SETTINGS: NomiorSchedulerSettings = Schema.decodeSync(
  NomiorSchedulerSettings,
)({});

export const SchedulerCandidate = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type SchedulerCandidate = typeof SchedulerCandidate.Type;

/**
 * The scheduler's advisory output. `disabled` and `no-candidates` carry no
 * instance on purpose — callers fall back to their existing default routing.
 * A `choice` always carries a human-readable reason for the UI.
 */
export const SchedulerDecision = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({ kind: Schema.Literal("no-candidates") }),
  Schema.Struct({
    kind: Schema.Literal("choice"),
    instanceId: ProviderInstanceId,
    /** Which rule won: surfaced verbatim in the UI next to the thread. */
    reason: Schema.String,
    rule: Schema.Literals([
      "manual-pin",
      "project-constraint",
      "sticky",
      "headroom",
      "round-robin",
    ]),
  }),
]);
export type SchedulerDecision = typeof SchedulerDecision.Type;
