/**
 * Integration: a review job's lifecycle through the REAL engine, store,
 * scheduler-backed leg runner and deterministic gate.
 *
 * Real: `ReviewJobStore` on sqlite with the real migrations, `ReviewEngine`,
 * `LegRunnerLive` + `InstanceScheduler` + `RateLimitObserver`, the gate, and
 * the one memory-candidate store.
 *
 * Stubbed: upstream's `ProviderInstanceRegistry` (building it for real needs
 * signed-in provider CLIs on the machine) and, per test, the `LegLauncher` —
 * which is the seam a real launch plugs into. `LegLauncher.layerHandOff`, the
 * shipped default, is exercised as-is in the first test.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { NomiorContextLive, NomiorSchedulerLive } from "../NomiorRuntime.ts";
import { NomiorProjects } from "../projects/NomiorProjects.ts";

interface MemoryRow {
  readonly text: string;
  readonly memorySource: string;
  readonly memoryKind: string;
  readonly originRef: string;
  readonly scopeValue: string;
}

/** Every `memory` source in the broker, with the provenance the writer stamped. */
const rememberedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<MemoryRow>`
    SELECT c.text AS "text",
           json_extract(s.provenance_json, '$.memorySource') AS "memorySource",
           json_extract(s.provenance_json, '$.memoryKind') AS "memoryKind",
           json_extract(s.provenance_json, '$.originRef') AS "originRef",
           sc.scope_value AS "scopeValue"
    FROM nomior_sources s
    JOIN nomior_source_scopes sc ON sc.source_id = s.id
    JOIN nomior_chunks c ON c.source_id = s.id AND c.ordinal = 0
    WHERE s.kind = 'memory'
  `;
}).pipe(Effect.orDie);

const rememberedTexts = Effect.map(rememberedRows, (rows) => rows.map((row) => row.text));
import { MemoryCandidateSinkLive } from "../memory/ReviewSinkLive.ts";
import { LegLauncher, LegRunnerLive, type LegLaunchInput } from "../wiring/LegRunnerLive.ts";
import type { LegRunResult, ReviewLegConfig } from "../review/Legs.ts";
import type { PlaybookPresence } from "../review/Playbook.ts";
import * as ReviewJobStore from "../review/ReviewJobStore.ts";
import { ReviewPublisher } from "../review/ReviewPublisher.ts";
import {
  ReviewEngine,
  ReviewEngineConfig,
  ReviewRunContexts,
  layer as ReviewEngineLayer,
  type ReviewEngineSettings,
  type ReviewRunContext,
} from "../review/ReviewEngine.ts";

const codexPersonal = ProviderInstanceId.make("codex_personal");
const codexWork = ProviderInstanceId.make("codex_work");

const stubInstance = (instanceId: ProviderInstanceId, driverKind: string): ProviderInstance =>
  ({
    instanceId,
    driverKind: driverKind as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: driverKind as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
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
  attachedTools: ["git-read"],
};

const playbook: PlaybookPresence = {
  kind: "present",
  playbook: {
    verify: "pnpm test",
    context: "A private fork; additive files only.",
    bar: "No unreviewed upstream file changes.",
  },
};

const runContext: ReviewRunContext = {
  legs: [legConfig],
  playbook,
  brief: { contextPacket: null, changeSummary: "Two files touched in apps/server." },
};

const launcherReturning = (
  launch: (input: LegLaunchInput) => Effect.Effect<LegRunResult, never>,
): Layer.Layer<LegLauncher> => Layer.succeed(LegLauncher, LegLauncher.of({ launch }));

interface AppOptions {
  /** Defaults to the shipped `LegLauncher.layerHandOff`. */
  readonly launcher?: Layer.Layer<LegLauncher> | undefined;
  readonly publisher?: Layer.Layer<ReviewPublisher> | undefined;
  readonly settings?: Partial<ReviewEngineSettings> | undefined;
  readonly instances?: ReadonlyArray<ProviderInstance> | undefined;
}

/** The checkout `nomior/nomior-code` would resolve to, so findings have a scope. */
const REVIEW_PROJECT_ID = ProjectId.make("proj-nomior-code");
const REVIEW_PROJECTS = NomiorProjects.layerStatic([
  {
    projectId: REVIEW_PROJECT_ID,
    title: "Nomior Code",
    workspaceRoot: "/w/nomior-code",
    repo: "nomior/nomior-code",
  },
]);

const makeAppLayer = (options: AppOptions = {}) =>
  ReviewEngineLayer.pipe(
    Layer.provide(ReviewRunContexts.layerStatic(runContext)),
    Layer.provide(ReviewEngineConfig.layerStatic(options.settings ?? {})),
    Layer.provideMerge(
      Layer.mergeAll(
        ReviewJobStore.layer,
        LegRunnerLive.pipe(Layer.provide(options.launcher ?? LegLauncher.layerHandOff)),
        options.publisher ?? ReviewPublisher.layerNoop,
        MemoryCandidateSinkLive.pipe(Layer.provide(REVIEW_PROJECTS)),
      ),
    ),
    Layer.provideMerge(NomiorSchedulerLive),
    Layer.provideMerge(NomiorContextLive),
    Layer.provide(registryStub(options.instances ?? [stubInstance(codexPersonal, "codex")])),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

const submitOne = Effect.fn("submitOne")(function* () {
  const engine = yield* ReviewEngine;
  return yield* engine.submit({
    repo: "nomior/nomior-code",
    target: { kind: "pull-request", number: 42 },
    headSha: "abc1234",
    riskTier: "medium",
  });
});

const cleanReport = JSON.stringify({
  findings: [],
  runtimeEvidence: [{ kind: "tests-run", detail: "pnpm test: 812 passed" }],
  needsExternalReview: false,
});

it.effect("the shipped default parks a job for a human instead of ruling on it", () =>
  Effect.gen(function* () {
    const engine = yield* ReviewEngine;
    const receipt = yield* submitOne();
    assert.isTrue(receipt.created);

    const outcome = yield* engine.processNext();
    assert.strictEqual(outcome.kind, "waiting-external");

    // Nothing decided, nothing published, nothing written to memory.
    assert.deepStrictEqual(yield* rememberedTexts, []);
  }).pipe(Effect.provide(makeAppLayer())),
);

it.effect("a clean leg with runtime evidence and a playbook approves through the gate", () =>
  Effect.gen(function* () {
    const engine = yield* ReviewEngine;
    yield* submitOne();
    const outcome = yield* engine.processNext();

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.strictEqual(outcome.verdict.decision, "approve");
    assert.strictEqual(outcome.job.status, "approved");
    // Publishing stays off: the flag defaults false and the engine says so.
    assert.isFalse(outcome.publish.posted);
    assert.include(outcome.publish.detail, "allowExternalPosting=false");
  }).pipe(
    Effect.provide(
      makeAppLayer({
        launcher: launcherReturning(() => Effect.succeed({ rawOutput: cleanReport })),
        // A publisher that dies if called: the assertion is that
        // `allowExternalPosting=false` never reaches it, not that it returns
        // a polite no.
        publisher: Layer.succeed(
          ReviewPublisher,
          ReviewPublisher.of({
            publish: () => Effect.die("ReviewPublisher was called with allowExternalPosting=false"),
          }),
        ),
      }),
    ),
  ),
);

it.effect("a critical finding blocks, and its findings become memory with no approval step", () =>
  Effect.gen(function* () {
    const engine = yield* ReviewEngine;
    yield* submitOne();
    const outcome = yield* engine.processNext();

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.strictEqual(outcome.verdict.decision, "not-approved");
    assert.strictEqual(outcome.job.status, "not-approved");

    const written = yield* rememberedRows;
    assert.isAbove(written.length, 0);
    for (const row of written) {
      assert.strictEqual(row.memorySource, "review");
      assert.strictEqual(row.originRef, "nomior/nomior-code@abc1234");
      // Scoped to the project the repo's checkout resolves to, never unscoped.
      assert.strictEqual(row.scopeValue, REVIEW_PROJECT_ID);
    }
    assert.isTrue(written.some((row) => row.memoryKind === "verdict"));
  }).pipe(
    Effect.provide(
      makeAppLayer({
        launcher: launcherReturning(() =>
          Effect.succeed({
            rawOutput: JSON.stringify({
              findings: [{ severity: "critical", summary: "Token written to the repo." }],
              runtimeEvidence: [{ kind: "tests-run", detail: "pnpm test" }],
              needsExternalReview: false,
            }),
          }),
        ),
      }),
    ),
  ),
);

it.effect("unparseable leg output fails closed rather than dropping the review", () =>
  Effect.gen(function* () {
    const engine = yield* ReviewEngine;
    yield* submitOne();
    const outcome = yield* engine.processNext();

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.strictEqual(outcome.verdict.decision, "not-approved");
    assert.isTrue(
      outcome.verdict.reasons.some((reason) => reason.includes("unparseable")),
      outcome.verdict.reasons.join(" | "),
    );
  }).pipe(
    Effect.provide(
      makeAppLayer({
        launcher: launcherReturning(() => Effect.succeed({ rawOutput: "I had a think." })),
      }),
    ),
  ),
);

it.effect("a leg naming an unregistered instance fails the attempt, not the process", () =>
  Effect.gen(function* () {
    const engine = yield* ReviewEngine;
    yield* submitOne();
    const outcome = yield* engine.processNext();

    // First attempt of four: a cooldown, not a terminal failure.
    assert.strictEqual(outcome.kind, "retry-scheduled");
    if (outcome.kind !== "retry-scheduled") return;
    assert.include(outcome.job.failureReason ?? "", "not registered");
  }).pipe(
    Effect.provide(
      makeAppLayer({
        launcher: launcherReturning(() => Effect.die("launcher must not be reached")),
        instances: [stubInstance(codexWork, "codex")],
      }),
    ),
  ),
);
