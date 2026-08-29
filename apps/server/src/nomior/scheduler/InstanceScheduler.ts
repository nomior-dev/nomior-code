/**
 * InstanceScheduler — advisory instance picker for NEW threads.
 *
 * Priority: manual pin > hard project constraint > sticky-per-project >
 * rate-limit headroom > round-robin. Every choice carries a reason string
 * for the UI, the feature is opt-in (settings default off), and the service
 * deliberately has no API that touches an existing thread: it cannot move
 * work between instances, only advise where a new thread should start.
 */
import type { ProjectId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { RateLimitObserver } from "./RateLimitObserver.ts";
import {
  DEFAULT_NOMIOR_SCHEDULER_SETTINGS,
  instanceHeadroom,
  type InstanceRateLimitState,
  type NomiorSchedulerSettings,
  type SchedulerCandidate,
  type SchedulerDecision,
} from "./Schemas.ts";

/**
 * Settings source for the scheduler. The default layer serves the schema
 * defaults (feature off); server wiring replaces it with a reader over the
 * live `ServerSettings` once the settings extension is registered.
 */
export class InstanceSchedulerConfig extends Context.Service<
  InstanceSchedulerConfig,
  { readonly current: Effect.Effect<NomiorSchedulerSettings> }
>()("t3/nomior/scheduler/InstanceScheduler/InstanceSchedulerConfig") {
  static readonly layerStatic = (settings?: Partial<NomiorSchedulerSettings>) =>
    Layer.succeed(
      InstanceSchedulerConfig,
      InstanceSchedulerConfig.of({
        current: Effect.succeed({ ...DEFAULT_NOMIOR_SCHEDULER_SETTINGS, ...settings }),
      }),
    );

  static readonly layerDefault = InstanceSchedulerConfig.layerStatic();
}

export interface PickNewThreadInstanceInput {
  readonly projectId: ProjectId;
  /** Enabled instances the caller would accept; the scheduler never invents one. */
  readonly candidates: ReadonlyArray<SchedulerCandidate>;
  /** The user's explicit instance choice for this thread, if they made one. */
  readonly requestedInstanceId?: ProviderInstanceId | undefined;
}

export interface InstanceSchedulerShape {
  /**
   * Advise which instance a NEW thread should start on. This is the whole
   * surface on purpose: nothing here accepts a thread id, so the scheduler
   * is structurally unable to reassign an existing thread.
   */
  readonly pickForNewThread: (
    input: PickNewThreadInstanceInput,
  ) => Effect.Effect<SchedulerDecision, PersistenceSqlError>;
}

export class InstanceScheduler extends Context.Service<InstanceScheduler, InstanceSchedulerShape>()(
  "t3/nomior/scheduler/InstanceScheduler",
) {}

const SchedulerAssignmentRow = Schema.Struct({
  projectId: Schema.String,
  instanceId: ProviderInstanceId,
  updatedAt: Schema.String,
});

const GetAssignmentInput = Schema.Struct({ projectId: Schema.String });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observer = yield* RateLimitObserver;
  const config = yield* InstanceSchedulerConfig;
  const roundRobinCursor = yield* Ref.make(0);

  const upsertAssignmentRow = SqlSchema.void({
    Request: SchedulerAssignmentRow,
    execute: (row) =>
      sql`
        INSERT INTO nomior_scheduler_assignments (project_id, instance_id, updated_at)
        VALUES (${row.projectId}, ${row.instanceId}, ${row.updatedAt})
        ON CONFLICT (project_id)
        DO UPDATE SET
          instance_id = excluded.instance_id,
          updated_at = excluded.updated_at
      `,
  });

  const findAssignmentRow = SqlSchema.findOneOption({
    Request: GetAssignmentInput,
    Result: SchedulerAssignmentRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          instance_id AS "instanceId",
          updated_at AS "updatedAt"
        FROM nomior_scheduler_assignments
        WHERE project_id = ${projectId}
      `,
  });

  const rememberChoice = Effect.fn("InstanceScheduler.rememberChoice")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* upsertAssignmentRow({ projectId, instanceId, updatedAt }).pipe(
      Effect.mapError(toPersistenceSqlError("InstanceScheduler.rememberChoice:query")),
    );
  });

  const pickForNewThread: InstanceSchedulerShape["pickForNewThread"] = Effect.fn(
    "InstanceScheduler.pickForNewThread",
  )(function* (input) {
    const settings = yield* config.current;
    if (!settings.enabled) {
      return { kind: "disabled" } as const;
    }
    if (input.candidates.length === 0) {
      return { kind: "no-candidates" } as const;
    }

    const choose = Effect.fn("InstanceScheduler.choose")(function* (
      instanceId: ProviderInstanceId,
      rule: Extract<SchedulerDecision, { kind: "choice" }>["rule"],
      reason: string,
    ) {
      yield* rememberChoice(input.projectId, instanceId);
      return { kind: "choice", instanceId, rule, reason } as const;
    });

    const hasCandidate = (instanceId: ProviderInstanceId) =>
      input.candidates.some((candidate) => candidate.instanceId === instanceId);

    // 1. Manual pin: an explicit per-thread request, then the per-project pin.
    if (input.requestedInstanceId !== undefined && hasCandidate(input.requestedInstanceId)) {
      return yield* choose(
        input.requestedInstanceId,
        "manual-pin",
        `Pinned to ${input.requestedInstanceId}: chosen manually for this thread.`,
      );
    }
    const projectPin = settings.pinnedInstanceByProject[input.projectId];
    if (projectPin !== undefined && hasCandidate(projectPin)) {
      return yield* choose(
        projectPin,
        "manual-pin",
        `Pinned to ${projectPin}: manual pin for this project.`,
      );
    }

    // 2. Hard project constraint: shrink the candidate set; never widen it.
    const allowed = settings.allowedInstancesByProject[input.projectId];
    const constrained =
      allowed === undefined || allowed.length === 0
        ? input.candidates
        : input.candidates.filter((candidate) => allowed.includes(candidate.instanceId));
    if (constrained.length === 0) {
      return { kind: "no-candidates" } as const;
    }
    const firstConstrained = constrained[0];
    if (
      constrained.length === 1 &&
      constrained.length < input.candidates.length &&
      firstConstrained
    ) {
      return yield* choose(
        firstConstrained.instanceId,
        "project-constraint",
        `Only ${firstConstrained.instanceId} is allowed for this project.`,
      );
    }

    const states = new Map<ProviderInstanceId, InstanceRateLimitState>();
    for (const candidate of constrained) {
      const state = yield* observer.stateFor(candidate.instanceId);
      if (Option.isSome(state)) {
        states.set(candidate.instanceId, state.value);
      }
    }
    const headroomOf = (candidate: SchedulerCandidate) => {
      const state = states.get(candidate.instanceId);
      return state === undefined ? 100 : instanceHeadroom(state);
    };

    // 3. Sticky-per-project, while the remembered instance still has headroom.
    if (settings.stickyByProject) {
      const assignment = yield* findAssignmentRow({ projectId: input.projectId }).pipe(
        Effect.mapError(toPersistenceSqlError("InstanceScheduler.pickForNewThread:query")),
      );
      if (Option.isSome(assignment)) {
        const sticky = constrained.find(
          (candidate) => candidate.instanceId === assignment.value.instanceId,
        );
        if (sticky !== undefined && states.get(sticky.instanceId)?.status !== "limited") {
          return yield* choose(
            sticky.instanceId,
            "sticky",
            `Staying on ${sticky.instanceId}: this project used it last and it still has headroom.`,
          );
        }
      }
    }

    // 4. Rate-limit headroom: a strict winner takes it; ties fall through.
    const ranked = [...constrained].sort(
      (left, right) =>
        headroomOf(right) - headroomOf(left) || left.instanceId.localeCompare(right.instanceId),
    );
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best !== undefined && runnerUp !== undefined && headroomOf(best) > headroomOf(runnerUp)) {
      return yield* choose(
        best.instanceId,
        "headroom",
        `Picked ${best.instanceId}: most rate-limit headroom (${headroomOf(best)}% vs ${headroomOf(runnerUp)}%).`,
      );
    }

    // 5. Round-robin over the tied-best candidates, in a stable order.
    const bestHeadroom = best === undefined ? 100 : headroomOf(best);
    const tied = ranked.filter((candidate) => headroomOf(candidate) === bestHeadroom);
    const cursor = yield* Ref.getAndUpdate(roundRobinCursor, (value) => value + 1);
    const chosen = tied[cursor % tied.length] ?? ranked[0];
    if (chosen === undefined) {
      return { kind: "no-candidates" } as const;
    }
    // Zero headroom across the board is not "evenly matched" — say so: this
    // is exactly the moment the UI reason matters most.
    return yield* choose(
      chosen.instanceId,
      "round-robin",
      bestHeadroom === 0
        ? `Picked ${chosen.instanceId} by rotation: every candidate is rate limited right now.`
        : `Picked ${chosen.instanceId} by rotation: candidates are evenly matched.`,
    );
  });

  return InstanceScheduler.of({ pickForNewThread });
});

export const layer = Layer.effect(InstanceScheduler, make);
