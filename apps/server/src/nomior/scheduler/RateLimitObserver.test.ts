import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RateLimitObserver from "./RateLimitObserver.ts";

const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");

let eventCounter = 0;
const makeRateLimitEvent = (input: {
  readonly provider: typeof claudeDriver;
  readonly instanceId?: string;
  readonly rateLimits: unknown;
}): ProviderRuntimeEvent => ({
  eventId: EventId.make(`evt-${++eventCounter}`),
  provider: input.provider,
  ...(input.instanceId === undefined
    ? {}
    : { providerInstanceId: ProviderInstanceId.make(input.instanceId) }),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-08-29T10:00:00.000Z",
  type: "account.rate-limits.updated",
  payload: { rateLimits: input.rateLimits },
});

const claudeRateLimits = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", ...info },
});

const TestLayer = RateLimitObserver.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

describe("normalizeRateLimitEvent", () => {
  it("normalizes a Claude rate_limit_event", () => {
    const state = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({
        provider: claudeDriver,
        instanceId: "claude-work",
        rateLimits: claudeRateLimits({
          status: "allowed_warning",
          utilization: 82,
          resetsAt: 1_788_004_800,
        }),
      }),
    );

    assert.isTrue(Option.isSome(state));
    if (Option.isNone(state)) return;
    assert.strictEqual(state.value.instanceId, "claude-work");
    assert.strictEqual(state.value.status, "warning");
    assert.strictEqual(state.value.usedPercent, 82);
    assert.strictEqual(state.value.resetsAt, "2026-08-29T12:00:00.000Z");
    assert.strictEqual(state.value.observedAt, "2026-08-29T10:00:00.000Z");
  });

  it("maps a Claude rejection to limited", () => {
    const state = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({
        provider: claudeDriver,
        instanceId: "claude-work",
        rateLimits: claudeRateLimits({ status: "rejected" }),
      }),
    );

    assert.isTrue(Option.isSome(state));
    if (Option.isNone(state)) return;
    assert.strictEqual(state.value.status, "limited");
    assert.strictEqual(state.value.usedPercent, null);
  });

  it("normalizes a Codex snapshot to its most constrained window", () => {
    const state = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({
        provider: codexDriver,
        instanceId: "codex-personal",
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 40, resetsAt: 1_788_004_800 },
            secondary: { usedPercent: 95, resetsAt: 1_788_091_200 },
          },
        },
      }),
    );

    assert.isTrue(Option.isSome(state));
    if (Option.isNone(state)) return;
    assert.strictEqual(state.value.status, "warning");
    assert.strictEqual(state.value.usedPercent, 95);
    assert.strictEqual(state.value.resetsAt, "2026-08-30T12:00:00.000Z");
  });

  it("marks an exhausted Codex window as limited", () => {
    const state = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({
        provider: codexDriver,
        instanceId: "codex-personal",
        rateLimits: { rateLimits: { primary: { usedPercent: 100 } } },
      }),
    );

    assert.isTrue(Option.isSome(state));
    if (Option.isNone(state)) return;
    assert.strictEqual(state.value.status, "limited");
  });

  it("falls back to the driver kind when the instance id is missing", () => {
    const state = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({
        provider: claudeDriver,
        rateLimits: claudeRateLimits({}),
      }),
    );

    assert.isTrue(Option.isSome(state));
    if (Option.isNone(state)) return;
    assert.strictEqual(state.value.instanceId, "claudeAgent");
  });

  it("produces no signal for unrecognized payloads and other event types", () => {
    const unrecognized = RateLimitObserver.normalizeRateLimitEvent(
      makeRateLimitEvent({ provider: claudeDriver, rateLimits: { surprise: true } }),
    );
    assert.isTrue(Option.isNone(unrecognized));

    const otherEvent: ProviderRuntimeEvent = {
      eventId: EventId.make("evt-other"),
      provider: claudeDriver,
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-08-29T10:00:00.000Z",
      type: "auth.status",
      payload: { isAuthenticating: false },
    };
    assert.isTrue(Option.isNone(RateLimitObserver.normalizeRateLimitEvent(otherEvent)));
  });
});

describe("RateLimitObserver", () => {
  it.effect("ingests events into the in-memory snapshot and the persisted table", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;

      yield* observer.ingest(
        makeRateLimitEvent({
          provider: claudeDriver,
          instanceId: "claude-work",
          rateLimits: claudeRateLimits({ status: "allowed_warning", utilization: 60 }),
        }),
      );
      // Ignored: not a rate-limit event.
      yield* observer.ingest({
        eventId: EventId.make("evt-noise"),
        provider: claudeDriver,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-08-29T10:00:00.000Z",
        type: "auth.status",
        payload: {},
      });

      const snapshot = yield* observer.snapshot();
      assert.strictEqual(snapshot.length, 1);
      const state = yield* observer.stateFor(ProviderInstanceId.make("claude-work"));
      assert.isTrue(Option.isSome(state));
      if (Option.isNone(state)) return;
      assert.strictEqual(state.value.status, "warning");

      // A second observer built over the same database restores the state,
      // proving the table is the durable source and the map is a cache.
      const restored = yield* RateLimitObserver.make;
      const restoredState = yield* restored.stateFor(ProviderInstanceId.make("claude-work"));
      assert.isTrue(Option.isSome(restoredState));
      if (Option.isNone(restoredState)) return;
      assert.strictEqual(restoredState.value.usedPercent, 60);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("newer events overwrite older state for the same instance", () =>
    Effect.gen(function* () {
      const observer = yield* RateLimitObserver.RateLimitObserver;
      const instanceId = ProviderInstanceId.make("claude-work");

      yield* observer.ingest(
        makeRateLimitEvent({
          provider: claudeDriver,
          instanceId: "claude-work",
          rateLimits: claudeRateLimits({ status: "allowed", utilization: 10 }),
        }),
      );
      yield* observer.ingest(
        makeRateLimitEvent({
          provider: claudeDriver,
          instanceId: "claude-work",
          rateLimits: claudeRateLimits({ status: "rejected", utilization: 100 }),
        }),
      );

      const state = yield* observer.stateFor(instanceId);
      assert.isTrue(Option.isSome(state));
      if (Option.isNone(state)) return;
      assert.strictEqual(state.value.status, "limited");
      assert.strictEqual(state.value.usedPercent, 100);
    }).pipe(Effect.provide(TestLayer)),
  );
});
