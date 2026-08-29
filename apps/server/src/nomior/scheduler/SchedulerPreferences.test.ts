import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DEFAULT_NOMIOR_SCHEDULER_SETTINGS } from "./Schemas.ts";
import { SchedulerPreferences, layer } from "./SchedulerPreferences.ts";

// A fresh in-memory database per test: these assertions are about what is and
// is not stored, so leaking rows between them would hide a default.
const testLayer = layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const claude = "inst-claude-main";
const codex = "inst-codex-main";
const now = "2026-08-29T08:40:00.000Z";

describe("SchedulerPreferences pins", () => {
  it.effect("pinning twice leaves one pin", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      yield* preferences.setPinned(claude, true, now);
      yield* preferences.setPinned(claude, true, "2026-08-29T09:00:00.000Z");

      const pinned = yield* preferences.listPinned();
      assert.deepStrictEqual([...pinned], [claude]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("unpinning twice is not an error, and unpinning what was never pinned is a no-op", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      yield* preferences.setPinned(claude, true, now);
      yield* preferences.setPinned(claude, false, now);
      yield* preferences.setPinned(claude, false, now);
      yield* preferences.setPinned(codex, false, now);

      const pinned = yield* preferences.listPinned();
      assert.deepStrictEqual([...pinned], []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("pins are per instance, not one global slot", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      yield* preferences.setPinned(claude, true, now);
      yield* preferences.setPinned(codex, true, now);
      yield* preferences.setPinned(claude, false, now);

      const pinned = yield* preferences.listPinned();
      assert.deepStrictEqual([...pinned], [codex]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("SchedulerPreferences advisory mode", () => {
  it.effect("defaults to on, so the scheduler suggests until the user opts in", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      assert.isTrue(yield* preferences.advisoryMode());
      // The default is the inverse of the scheduler's own opt-in flag, not a
      // second constant that can drift away from it.
      assert.isFalse(DEFAULT_NOMIOR_SCHEDULER_SETTINGS.enabled);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("round-trips both ways", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      yield* preferences.setAdvisoryMode(false);
      assert.isFalse(yield* preferences.advisoryMode());
      yield* preferences.setAdvisoryMode(true);
      assert.isTrue(yield* preferences.advisoryMode());
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("SchedulerPreferences last decision", () => {
  it.effect("is empty until the scheduler records one", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      assert.isTrue(Option.isNone(yield* preferences.lastDecision()));

      // Advisory mode shares the row; writing it must not invent a decision.
      yield* preferences.setAdvisoryMode(false);
      assert.isTrue(Option.isNone(yield* preferences.lastDecision()));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps only the newest decision, and leaves advisory mode alone", () =>
    Effect.gen(function* () {
      const preferences = yield* SchedulerPreferences;
      yield* preferences.setAdvisoryMode(false);
      yield* preferences.recordDecision({
        instanceId: claude,
        reason: "Picked Claude — main: most rate-limit headroom (72%).",
        decidedAt: now,
      });
      yield* preferences.recordDecision({
        instanceId: codex,
        reason: "Picked Codex — main by rotation: candidates are evenly matched.",
        decidedAt: "2026-08-29T09:15:00.000Z",
      });

      const decision = yield* preferences.lastDecision();
      assert.deepStrictEqual(
        Option.getOrNull(decision),
        {
          instanceId: codex,
          reason: "Picked Codex — main by rotation: candidates are evenly matched.",
          decidedAt: "2026-08-29T09:15:00.000Z",
        },
        "the panel shows one decision: the last one",
      );
      assert.isFalse(yield* preferences.advisoryMode());
    }).pipe(Effect.provide(testLayer)),
  );
});
