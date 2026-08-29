import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as InstanceScheduler from "./InstanceScheduler.ts";
import * as RateLimitObserver from "./RateLimitObserver.ts";
import * as SchedulerPreferences from "./SchedulerPreferences.ts";
import type { NomiorSchedulerSettings, SchedulerDecision } from "./Schemas.ts";

const claudeDriver = ProviderDriverKind.make("claudeAgent");
const projectId = ProjectId.make("project-1");
const work = ProviderInstanceId.make("claude-work");
const personal = ProviderInstanceId.make("claude-personal");

const candidates = [
  { instanceId: work, driver: claudeDriver },
  { instanceId: personal, driver: claudeDriver },
];

const makeTestLayer = (settings?: Partial<NomiorSchedulerSettings>) =>
  InstanceScheduler.layer.pipe(
    Layer.provide(InstanceScheduler.InstanceSchedulerConfig.layerStatic(settings)),
    Layer.provideMerge(RateLimitObserver.layer),
    Layer.provideMerge(SchedulerPreferences.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

let eventCounter = 0;
const rateLimitEvent = (
  instanceId: ProviderInstanceId,
  utilization: number,
): ProviderRuntimeEvent => ({
  eventId: EventId.make(`evt-${++eventCounter}`),
  provider: claudeDriver,
  providerInstanceId: instanceId,
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-08-29T10:00:00.000Z",
  type: "account.rate-limits.updated",
  payload: {
    rateLimits: {
      type: "rate_limit_event",
      rate_limit_info: {
        status: utilization >= 100 ? "rejected" : "allowed",
        utilization,
      },
    },
  },
});

const expectChoice = (decision: SchedulerDecision) => {
  assert.strictEqual(decision.kind, "choice");
  if (decision.kind !== "choice") throw new Error("expected a choice");
  assert.isAbove(decision.reason.length, 0, "every choice carries a reason for the UI");
  return decision;
};

describe("InstanceScheduler", () => {
  it.effect("is opt-in: the default settings disable it entirely", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = yield* scheduler.pickForNewThread({ projectId, candidates });
      assert.deepStrictEqual(decision, { kind: "disabled" });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("returns no-candidates when nothing is eligible", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = yield* scheduler.pickForNewThread({ projectId, candidates: [] });
      assert.deepStrictEqual(decision, { kind: "no-candidates" });
    }).pipe(Effect.provide(makeTestLayer({ enabled: true }))),
  );

  it.effect("honors an explicit per-thread request above every other rule", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;
      // Even a limited instance is honored when manually requested.
      yield* observer.ingest(rateLimitEvent(personal, 100));

      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = expectChoice(
        yield* scheduler.pickForNewThread({
          projectId,
          candidates,
          requestedInstanceId: personal,
        }),
      );
      assert.strictEqual(decision.instanceId, personal);
      assert.strictEqual(decision.rule, "manual-pin");
    }).pipe(Effect.provide(makeTestLayer({ enabled: true }))),
  );

  it.effect("honors the per-project pin from settings", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.strictEqual(decision.instanceId, personal);
      assert.strictEqual(decision.rule, "manual-pin");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          enabled: true,
          pinnedInstanceByProject: { [projectId]: personal },
        }),
      ),
    ),
  );

  it.effect("applies the hard project constraint", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;

      const constrainedChoice = expectChoice(
        yield* scheduler.pickForNewThread({ projectId, candidates }),
      );
      assert.strictEqual(constrainedChoice.instanceId, work);
      assert.strictEqual(constrainedChoice.rule, "project-constraint");

      // A constraint that matches nothing eligible yields no candidates
      // rather than silently widening the set.
      const otherProject = ProjectId.make("project-2");
      const impossible = yield* scheduler.pickForNewThread({
        projectId: otherProject,
        candidates: [{ instanceId: personal, driver: claudeDriver }],
      });
      assert.deepStrictEqual(impossible, { kind: "no-candidates" });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          enabled: true,
          allowedInstancesByProject: {
            [projectId]: [work],
            [ProjectId.make("project-2")]: [work],
          },
        }),
      ),
    ),
  );

  it.effect("stays sticky per project while the last instance has headroom", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;

      const first = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      const second = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.strictEqual(second.instanceId, first.instanceId);
      assert.strictEqual(second.rule, "sticky");
    }).pipe(Effect.provide(makeTestLayer({ enabled: true }))),
  );

  it.effect("abandons stickiness when the remembered instance is rate limited", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;
      const scheduler = yield* InstanceScheduler.InstanceScheduler;

      const first = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      yield* observer.ingest(rateLimitEvent(first.instanceId, 100));

      const second = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.notStrictEqual(second.instanceId, first.instanceId);
      assert.strictEqual(second.rule, "headroom");
    }).pipe(Effect.provide(makeTestLayer({ enabled: true }))),
  );

  it.effect("prefers the instance with the most rate-limit headroom", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;
      yield* observer.ingest(rateLimitEvent(work, 80));
      yield* observer.ingest(rateLimitEvent(personal, 20));

      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.strictEqual(decision.instanceId, personal);
      assert.strictEqual(decision.rule, "headroom");
      assert.match(decision.reason, /headroom/);
    }).pipe(Effect.provide(makeTestLayer({ enabled: true, stickyByProject: false }))),
  );

  it.effect("round-robins across evenly matched instances", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;

      const first = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      const second = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.strictEqual(first.rule, "round-robin");
      assert.strictEqual(second.rule, "round-robin");
      assert.notStrictEqual(second.instanceId, first.instanceId);
    }).pipe(Effect.provide(makeTestLayer({ enabled: true, stickyByProject: false }))),
  );

  it.effect("says every candidate is limited instead of calling them evenly matched", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;
      yield* observer.ingest(rateLimitEvent(work, 100));
      yield* observer.ingest(rateLimitEvent(personal, 100));

      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      const decision = expectChoice(yield* scheduler.pickForNewThread({ projectId, candidates }));
      assert.strictEqual(decision.rule, "round-robin");
      assert.match(decision.reason, /rate limited/);
      assert.notMatch(decision.reason, /evenly matched/);
    }).pipe(Effect.provide(makeTestLayer({ enabled: true, stickyByProject: false }))),
  );

  it.effect("cannot move an existing thread: the service exposes only new-thread advice", () =>
    Effect.gen(function* () {
      const scheduler = yield* InstanceScheduler.InstanceScheduler;
      // The whole service surface is one advisory method. There is no API
      // that takes a thread id, so reassigning a running thread is
      // structurally impossible from this module.
      assert.deepStrictEqual(Object.keys(scheduler).sort(), ["pickForNewThread"]);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
