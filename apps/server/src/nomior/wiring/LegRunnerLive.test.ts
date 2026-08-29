/**
 * Focused tests for the leg runner's own decisions. The scheduler-driven
 * routing is covered end to end in
 * `nomior/integration/SchedulerDecisions.test.ts`; this file is about the
 * shipped default launcher and the guards in front of it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { LegRunner, parseLegOutput, type ReviewLegConfig } from "../review/Legs.ts";
import {
  InstanceSchedulerConfig,
  layer as InstanceSchedulerLayer,
} from "../scheduler/InstanceScheduler.ts";
import * as RateLimitObserver from "../scheduler/RateLimitObserver.ts";
import * as SchedulerPreferences from "../scheduler/SchedulerPreferences.ts";
import { LegLauncher, LegRunnerLive } from "./LegRunnerLive.ts";

const codexDriver = ProviderDriverKind.make("codex");
const codexPersonal = ProviderInstanceId.make("codex_personal");

const stubInstance = (instanceId: ProviderInstanceId, enabled: boolean): ProviderInstance =>
  ({
    instanceId,
    driverKind: codexDriver,
    continuationIdentity: { driverKind: codexDriver, continuationKey: `${instanceId}:test` },
    displayName: undefined,
    enabled,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

const registryStub = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  });

const legConfig: ReviewLegConfig = {
  role: "codex-read",
  instanceId: codexPersonal,
  model: "gpt-5.6-sol",
  attachedTools: [],
};

const makeLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  LegRunnerLive.pipe(
    Layer.provide(LegLauncher.layerHandOff),
    Layer.provide(InstanceSchedulerLayer),
    Layer.provide(RateLimitObserver.layer),
    Layer.provide(SchedulerPreferences.layer),
    Layer.provide(InstanceSchedulerConfig.layerDefault),
    Layer.provide(registryStub(instances)),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

describe("LegLauncher.layerHandOff", () => {
  it.effect("emits a parseable report that asks for a human, never a clean pass", () =>
    Effect.gen(function* () {
      const runner = yield* LegRunner;
      const result = yield* runner.run(legConfig, "the brief");

      const parsed = parseLegOutput("codex-read", result.rawOutput);
      assert.strictEqual(parsed.outcome, "parsed");
      if (parsed.outcome !== "parsed") return;
      // needsExternalReview short-circuits the gate into `waiting-external`,
      // so a review nobody ran can never be recorded as approved.
      assert.isTrue(parsed.report.needsExternalReview);
      assert.deepStrictEqual(parsed.report.findings, []);
      assert.deepStrictEqual(parsed.report.runtimeEvidence, []);
      assert.strictEqual(result.instanceId, codexPersonal);
    }).pipe(Effect.provide(makeLayer([stubInstance(codexPersonal, true)]))),
  );
});

describe("LegRunnerLive guards", () => {
  it.effect("refuses a leg whose instance is not registered", () =>
    Effect.gen(function* () {
      const runner = yield* LegRunner;
      const error = yield* runner.run(legConfig, "the brief").pipe(Effect.flip);
      assert.strictEqual(error._tag, "NomiorLegRunError");
      assert.strictEqual(error.legRole, "codex-read");
      assert.isFalse(error.rateLimited);
      assert.include(error.detail, "not registered");
    }).pipe(Effect.provide(makeLayer([]))),
  );

  it.effect("refuses a leg whose instance is registered but disabled", () =>
    Effect.gen(function* () {
      const runner = yield* LegRunner;
      const error = yield* runner.run(legConfig, "the brief").pipe(Effect.flip);
      assert.include(error.detail, "is disabled");
    }).pipe(Effect.provide(makeLayer([stubInstance(codexPersonal, false)]))),
  );
});
