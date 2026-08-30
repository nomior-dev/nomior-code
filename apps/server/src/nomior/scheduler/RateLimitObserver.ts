/**
 * RateLimitObserver — consumes the credential-free rate-limit runtime events
 * the provider adapters already emit and maintains a per-instance headroom
 * table (in-memory, mirrored to `nomior_instance_rate_limits`).
 *
 * Signal sources:
 * - Claude: `rate_limit_event` SDK messages forwarded as
 *   `account.rate-limits.updated` (`provider/Layers/ClaudeAdapter.ts`).
 * - Codex: `account/rateLimits/updated` app-server notifications forwarded the
 *   same way (`provider/Layers/CodexAdapter.ts`).
 *
 * The payloads are `Schema.Unknown` on the wire contract, so this module
 * re-parses them defensively; an unrecognized payload is simply no signal.
 * This module must never read credentials — no keychain, no provider homes,
 * no usage-endpoint polling (asserted by `credentialIsolation.test.ts`).
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { InstanceRateLimitState } from "./Schemas.ts";

/** Claude SDK `rate_limit_event` message, as forwarded in `payload.rateLimits`. */
const ClaudeRateLimitMessage = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  rate_limit_info: Schema.Struct({
    status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
    resetsAt: Schema.optional(Schema.Number),
    utilization: Schema.optional(Schema.Number),
  }),
});

const CodexRateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/** Codex `account/rateLimits/updated` notification, as forwarded in `payload.rateLimits`. */
const CodexRateLimitNotification = Schema.Struct({
  rateLimits: Schema.Struct({
    primary: Schema.optionalKey(Schema.NullOr(CodexRateLimitWindow)),
    secondary: Schema.optionalKey(Schema.NullOr(CodexRateLimitWindow)),
  }),
});

const decodeClaude = Schema.decodeUnknownOption(ClaudeRateLimitMessage);
const decodeCodex = Schema.decodeUnknownOption(CodexRateLimitNotification);

const CODEX_WARNING_USED_PERCENT = 90;

const epochSecondsToIso = (seconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

/**
 * Normalize one `account.rate-limits.updated` event into an
 * `InstanceRateLimitState`. Any other event type, and any payload this build
 * cannot decode, is `Option.none` — no signal beats a wrong signal.
 */
export const normalizeRateLimitEvent = (
  event: ProviderRuntimeEvent,
): Option.Option<InstanceRateLimitState> => {
  if (event.type !== "account.rate-limits.updated") {
    return Option.none();
  }
  // Legacy emitters may omit the instance id during the upstream
  // driver/instance migration; those default instances are keyed by driver.
  const instanceId = event.providerInstanceId ?? ProviderInstanceId.make(event.provider);
  const base = {
    instanceId,
    provider: event.provider,
    observedAt: event.createdAt,
  };

  const claude = decodeClaude(event.payload.rateLimits);
  if (Option.isSome(claude)) {
    const info = claude.value.rate_limit_info;
    return Option.some({
      ...base,
      status:
        info.status === "rejected"
          ? "limited"
          : info.status === "allowed_warning"
            ? "warning"
            : "ok",
      usedPercent: info.utilization ?? null,
      resetsAt: info.resetsAt === undefined ? null : epochSecondsToIso(info.resetsAt),
    });
  }

  const codex = decodeCodex(event.payload.rateLimits);
  if (Option.isSome(codex)) {
    const windows = [codex.value.rateLimits.primary, codex.value.rateLimits.secondary].filter(
      (window): window is typeof CodexRateLimitWindow.Type =>
        window !== null && window !== undefined,
    );
    if (windows.length === 0) {
      return Option.none();
    }
    const mostConstrained = windows.reduce((left, right) =>
      right.usedPercent > left.usedPercent ? right : left,
    );
    const usedPercent = mostConstrained.usedPercent;
    const resetsAt = mostConstrained.resetsAt;
    return Option.some({
      ...base,
      status:
        usedPercent >= 100
          ? "limited"
          : usedPercent >= CODEX_WARNING_USED_PERCENT
            ? "warning"
            : "ok",
      usedPercent,
      resetsAt: resetsAt === null || resetsAt === undefined ? null : epochSecondsToIso(resetsAt),
    });
  }

  return Option.none();
};

export interface RateLimitObserverShape {
  /** Fold one runtime event into the headroom table. Non-rate-limit events are ignored. */
  readonly ingest: (event: ProviderRuntimeEvent) => Effect.Effect<void, PersistenceSqlError>;
  /** Current normalized state for every instance that has ever reported. */
  readonly snapshot: () => Effect.Effect<ReadonlyArray<InstanceRateLimitState>>;
  readonly stateFor: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<InstanceRateLimitState>>;
}

export class RateLimitObserver extends Context.Service<RateLimitObserver, RateLimitObserverShape>()(
  "t3/nomior/scheduler/RateLimitObserver",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertStateRow = SqlSchema.void({
    Request: InstanceRateLimitState,
    execute: (state) =>
      sql`
        INSERT INTO nomior_instance_rate_limits (
          instance_id,
          provider,
          status,
          used_percent,
          resets_at,
          observed_at
        )
        VALUES (
          ${state.instanceId},
          ${state.provider},
          ${state.status},
          ${state.usedPercent},
          ${state.resetsAt},
          ${state.observedAt}
        )
        ON CONFLICT (instance_id)
        DO UPDATE SET
          provider = excluded.provider,
          status = excluded.status,
          used_percent = excluded.used_percent,
          resets_at = excluded.resets_at,
          observed_at = excluded.observed_at
      `,
  });

  const listStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: InstanceRateLimitState,
    execute: () =>
      sql`
        SELECT
          instance_id AS "instanceId",
          provider,
          status,
          used_percent AS "usedPercent",
          resets_at AS "resetsAt",
          observed_at AS "observedAt"
        FROM nomior_instance_rate_limits
      `,
  });

  const persisted = yield* listStateRows(undefined).pipe(
    Effect.mapError(toPersistenceSqlError("RateLimitObserver.load:query")),
  );
  const states = yield* Ref.make(
    new Map<ProviderInstanceId, InstanceRateLimitState>(
      persisted.map((state) => [state.instanceId, state]),
    ),
  );

  const ingest: RateLimitObserverShape["ingest"] = Effect.fn("RateLimitObserver.ingest")(
    function* (event) {
      const normalized = normalizeRateLimitEvent(event);
      if (Option.isNone(normalized)) {
        return;
      }
      const state = normalized.value;
      yield* Ref.update(states, (current) => {
        const next = new Map(current);
        next.set(state.instanceId, state);
        return next;
      });
      yield* upsertStateRow(state).pipe(
        Effect.mapError(toPersistenceSqlError("RateLimitObserver.ingest:query")),
      );
    },
  );

  const snapshot: RateLimitObserverShape["snapshot"] = () =>
    Ref.get(states).pipe(Effect.map((current) => [...current.values()]));

  const stateFor: RateLimitObserverShape["stateFor"] = (instanceId) =>
    Ref.get(states).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(instanceId))));

  return RateLimitObserver.of({ ingest, snapshot, stateFor });
});

export const layer = Layer.effect(RateLimitObserver, make);

/**
 * Optional daemon wiring: fold the live provider runtime event stream into
 * the observer. Kept separate from `layer` so the observer core stays free of
 * the (large) ProviderService dependency in tests and in the CLI.
 */
export const daemonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const observer = yield* RateLimitObserver;
    const providers = yield* ProviderService;
    yield* Stream.runForEach(providers.streamEvents, (event) =>
      observer.ingest(event).pipe(Effect.catchTag("PersistenceSqlError", Effect.logWarning)),
    ).pipe(Effect.forkScoped);
  }),
);
