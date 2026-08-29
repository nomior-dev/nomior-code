/**
 * Integration: scheduler decisions, and the reason travelling all the way to a
 * review leg's result.
 *
 * Real: `RateLimitObserver` + `InstanceScheduler` on sqlite with the real
 * migrations, and `LegRunnerLive`. Stubbed: upstream's
 * `ProviderInstanceRegistry` and the `LegLauncher` (see `ReviewLifecycle.test.ts`).
 *
 * The point of these assertions is the *reason strings*: the scheduler is
 * advisory, so a decision nobody can explain is a decision nobody will trust.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { LegLauncher, LegRunnerLive } from "../wiring/LegRunnerLive.ts";
import { LegRunner, reviewSchedulerProjectKey, type ReviewLegConfig } from "../review/Legs.ts";
import {
  InstanceScheduler,
  InstanceSchedulerConfig,
  layer as InstanceSchedulerLayer,
} from "../scheduler/InstanceScheduler.ts";
import * as RateLimitObserver from "../scheduler/RateLimitObserver.ts";
import * as SchedulerPreferences from "../scheduler/SchedulerPreferences.ts";
import type { NomiorSchedulerSettings } from "../scheduler/Schemas.ts";

const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexPersonal = ProviderInstanceId.make("codex_personal");
const codexWork = ProviderInstanceId.make("codex_work");
const claudeWork = ProviderInstanceId.make("claude_work");

const stubInstance = (
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
): ProviderInstance =>
  ({
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `${instanceId}:test` },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

const allInstances = [
  stubInstance(codexPersonal, codexDriver),
  stubInstance(codexWork, codexDriver),
  stubInstance(claudeWork, claudeDriver),
];

const registryStub = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (id) => Effect.succeed(allInstances.find((instance) => instance.instanceId === id)),
  listInstances: Effect.succeed(allInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

let eventCounter = 0;
const exhaustedCodexWindow = (instanceId: ProviderInstanceId): ProviderRuntimeEvent => ({
  eventId: EventId.make(`evt-${++eventCounter}`),
  provider: codexDriver,
  providerInstanceId: instanceId,
  threadId: ThreadId.make("thread-scheduler-test"),
  createdAt: "2026-08-29T10:00:00.000Z",
  type: "account.rate-limits.updated",
  payload: { rateLimits: { rateLimits: { primary: { usedPercent: 100, resetsAt: null } } } },
});

const legConfig: ReviewLegConfig = {
  role: "codex-read",
  instanceId: codexPersonal,
  model: "gpt-5.6-sol",
  attachedTools: [],
};

const makeLayer = (settings?: Partial<NomiorSchedulerSettings>) =>
  LegRunnerLive.pipe(
    Layer.provide(LegLauncher.layerHandOff),
    Layer.provideMerge(InstanceSchedulerLayer),
    Layer.provideMerge(RateLimitObserver.layer),
    Layer.provideMerge(SchedulerPreferences.layer),
    Layer.provide(InstanceSchedulerConfig.layerStatic(settings)),
    Layer.provide(registryStub),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

const reviewProject = ProjectId.make(reviewSchedulerProjectKey("nomior/nomior-code"));

it.effect("a disabled scheduler advises nothing and the leg keeps its declared instance", () =>
  Effect.gen(function* () {
    const scheduler = yield* InstanceScheduler;
    const decision = yield* scheduler.pickForNewThread({
      projectId: reviewProject,
      candidates: [{ instanceId: codexPersonal, driver: codexDriver }],
    });
    assert.strictEqual(decision.kind, "disabled");

    const runner = yield* LegRunner;
    const result = yield* runner.run(legConfig, "brief", { projectId: reviewProject });
    assert.strictEqual(result.instanceId, codexPersonal);
    assert.isUndefined(result.schedulerReason);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an exhausted window moves the leg to the sibling account, with the reason", () =>
  Effect.gen(function* () {
    const observer = yield* RateLimitObserver.RateLimitObserver;
    yield* observer.ingest(exhaustedCodexWindow(codexPersonal));

    const runner = yield* LegRunner;
    const result = yield* runner.run(legConfig, "brief", { projectId: reviewProject });

    assert.strictEqual(result.instanceId, codexWork);
    assert.include(result.schedulerReason ?? "", "most rate-limit headroom");
    assert.include(result.schedulerReason ?? "", "100% vs 0%");
  }).pipe(Effect.provide(makeLayer({ enabled: true }))),
);

it.effect("a leg never crosses drivers: a Claude account is not a Codex leg's fallback", () =>
  Effect.gen(function* () {
    const observer = yield* RateLimitObserver.RateLimitObserver;
    yield* observer.ingest(exhaustedCodexWindow(codexPersonal));
    yield* observer.ingest(exhaustedCodexWindow(codexWork));

    const runner = yield* LegRunner;
    const result = yield* runner.run(legConfig, "brief", { projectId: reviewProject });

    assert.oneOf(result.instanceId, [codexPersonal, codexWork]);
    assert.include(result.schedulerReason ?? "", "every candidate is rate limited right now");
  }).pipe(Effect.provide(makeLayer({ enabled: true }))),
);

it.effect("sticky keeps a repo's next leg on the account its last leg used", () =>
  Effect.gen(function* () {
    const runner = yield* LegRunner;
    const first = yield* runner.run(legConfig, "brief", { projectId: reviewProject });
    const second = yield* runner.run(legConfig, "brief", { projectId: reviewProject });

    assert.strictEqual(second.instanceId, first.instanceId);
    assert.include(second.schedulerReason ?? "", "this project used it last");
  }).pipe(Effect.provide(makeLayer({ enabled: true }))),
);

it.effect("a hard project constraint narrows the choice and says which rule won", () =>
  Effect.gen(function* () {
    const scheduler = yield* InstanceScheduler;
    const decision = yield* scheduler.pickForNewThread({
      projectId: reviewProject,
      candidates: [
        { instanceId: codexPersonal, driver: codexDriver },
        { instanceId: codexWork, driver: codexDriver },
      ],
    });
    assert.strictEqual(decision.kind, "choice");
    if (decision.kind !== "choice") return;
    assert.strictEqual(decision.rule, "project-constraint");
    assert.strictEqual(decision.instanceId, codexWork);
    assert.include(decision.reason, "Only codex_work is allowed for this project.");
  }).pipe(
    Effect.provide(
      makeLayer({
        enabled: true,
        allowedInstancesByProject: { [reviewProject]: [codexWork] },
      }),
    ),
  ),
);
