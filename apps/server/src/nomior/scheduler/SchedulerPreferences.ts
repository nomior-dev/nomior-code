/**
 * SchedulerPreferences — the writes behind the instances panel: manual pins,
 * advisory mode, and the last decision the scheduler surfaced.
 *
 * Pins live in `nomior_instance_pins` (Nomior migration 006), where a present
 * row *is* the pin, so both directions of `setPinned` are idempotent by
 * construction.
 *
 * Advisory mode and the last decision are neither user-edited server settings
 * (`settings.json` is upstream's file and carries no Nomior slot) nor
 * per-project sticky assignments (`nomior_scheduler_assignments` is keyed by
 * project and has no room for a reason), so they get their own single-row
 * table, `nomior_scheduler_preferences` (Nomior migration 007).
 *
 * @module nomior/scheduler/SchedulerPreferences
 */
import type { IsoDateTime, NomiorSchedulerDecision } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { DEFAULT_NOMIOR_SCHEDULER_SETTINGS } from "./Schemas.ts";

/**
 * Advisory mode is the inverse of the scheduler's own opt-in flag: while the
 * scheduler is off, all it may do is suggest. Derived rather than restated so
 * `NomiorSchedulerSettings.enabled` stays the only default anyone edits.
 */
export const DEFAULT_ADVISORY_MODE = !DEFAULT_NOMIOR_SCHEDULER_SETTINGS.enabled;

export interface SchedulerPreferencesShape {
  /** Instance ids the user pinned. A pin is global, not per project. */
  readonly listPinned: () => Effect.Effect<ReadonlySet<string>, PersistenceSqlError>;
  /** Idempotent both ways; `now` only dates a pin that did not exist yet. */
  readonly setPinned: (
    instanceId: string,
    pinned: boolean,
    now: IsoDateTime,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly advisoryMode: () => Effect.Effect<boolean, PersistenceSqlError>;
  readonly setAdvisoryMode: (enabled: boolean) => Effect.Effect<void, PersistenceSqlError>;
  readonly lastDecision: () => Effect.Effect<
    Option.Option<NomiorSchedulerDecision>,
    PersistenceSqlError
  >;
  readonly recordDecision: (
    decision: NomiorSchedulerDecision,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class SchedulerPreferences extends Context.Service<
  SchedulerPreferences,
  SchedulerPreferencesShape
>()("t3/nomior/scheduler/SchedulerPreferences") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listPinned: SchedulerPreferencesShape["listPinned"] = Effect.fn(
    "SchedulerPreferences.listPinned",
  )(function* () {
    const rows = yield* sql<{ readonly instanceId: string }>`
      SELECT instance_id AS "instanceId"
      FROM nomior_instance_pins
    `.pipe(Effect.mapError(toPersistenceSqlError("SchedulerPreferences.listPinned")));
    return new Set(rows.map((row) => row.instanceId));
  });

  const setPinned: SchedulerPreferencesShape["setPinned"] = Effect.fn(
    "SchedulerPreferences.setPinned",
  )(function* (instanceId, pinned, now) {
    const statement = pinned
      ? sql`
          INSERT INTO nomior_instance_pins (instance_id, pinned_at)
          VALUES (${instanceId}, ${now})
          ON CONFLICT (instance_id) DO NOTHING
        `
      : sql`
          DELETE FROM nomior_instance_pins
          WHERE instance_id = ${instanceId}
        `;
    yield* statement.pipe(
      Effect.mapError(toPersistenceSqlError("SchedulerPreferences.setPinned")),
      Effect.asVoid,
    );
  });

  const advisoryMode: SchedulerPreferencesShape["advisoryMode"] = Effect.fn(
    "SchedulerPreferences.advisoryMode",
  )(function* () {
    const rows = yield* sql<{ readonly advisoryMode: number | null }>`
      SELECT advisory_mode AS "advisoryMode"
      FROM nomior_scheduler_preferences
      WHERE id = 1
    `.pipe(Effect.mapError(toPersistenceSqlError("SchedulerPreferences.advisoryMode")));
    const stored = rows[0]?.advisoryMode;
    return stored === undefined || stored === null ? DEFAULT_ADVISORY_MODE : stored !== 0;
  });

  const setAdvisoryMode: SchedulerPreferencesShape["setAdvisoryMode"] = Effect.fn(
    "SchedulerPreferences.setAdvisoryMode",
  )(function* (enabled) {
    yield* sql`
      INSERT INTO nomior_scheduler_preferences (id, advisory_mode)
      VALUES (1, ${enabled ? 1 : 0})
      ON CONFLICT (id) DO UPDATE SET advisory_mode = excluded.advisory_mode
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SchedulerPreferences.setAdvisoryMode")),
      Effect.asVoid,
    );
  });

  const lastDecision: SchedulerPreferencesShape["lastDecision"] = Effect.fn(
    "SchedulerPreferences.lastDecision",
  )(function* () {
    const rows = yield* sql<{
      readonly instanceId: string | null;
      readonly reason: string | null;
      readonly decidedAt: string | null;
    }>`
      SELECT
        last_decision_instance_id AS "instanceId",
        last_decision_reason AS "reason",
        last_decision_decided_at AS "decidedAt"
      FROM nomior_scheduler_preferences
      WHERE id = 1
    `.pipe(Effect.mapError(toPersistenceSqlError("SchedulerPreferences.lastDecision")));
    const row = rows[0];
    if (
      row === undefined ||
      row.instanceId === null ||
      row.reason === null ||
      row.decidedAt === null
    ) {
      return Option.none();
    }
    return Option.some({
      instanceId: row.instanceId,
      reason: row.reason,
      decidedAt: row.decidedAt,
    });
  });

  const recordDecision: SchedulerPreferencesShape["recordDecision"] = Effect.fn(
    "SchedulerPreferences.recordDecision",
  )(function* (decision) {
    yield* sql`
      INSERT INTO nomior_scheduler_preferences (
        id,
        last_decision_instance_id,
        last_decision_reason,
        last_decision_decided_at
      )
      VALUES (1, ${decision.instanceId}, ${decision.reason}, ${decision.decidedAt})
      ON CONFLICT (id) DO UPDATE SET
        last_decision_instance_id = excluded.last_decision_instance_id,
        last_decision_reason = excluded.last_decision_reason,
        last_decision_decided_at = excluded.last_decision_decided_at
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SchedulerPreferences.recordDecision")),
      Effect.asVoid,
    );
  });

  return SchedulerPreferences.of({
    listPinned,
    setPinned,
    advisoryMode,
    setAdvisoryMode,
    lastDecision,
    recordDecision,
  });
});

export const layer = Layer.effect(SchedulerPreferences, make);
