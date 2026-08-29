/**
 * LegRunnerLive — the production `LegRunner`: pick a provider instance through
 * the Nomior scheduler, verify it against upstream's instance registry, then
 * hand the brief to a `LegLauncher`.
 *
 * ## Why this lives in `wiring/` and not in `review/`
 *
 * `scheduler/credentialIsolation.test.ts` sweeps `review/` (and `scheduler/`,
 * and the migrations) and fails on any import outside a credential-free
 * allowlist, and on any `spawn(`/`HttpClient`/provider-home identifier. That
 * guard is what keeps the review engine unable to reach a credential even by
 * accident, and it is the reason `LegRunner` is a port at all. This module is
 * the one place allowed to hold the other end of that port, so it sits outside
 * the swept tree rather than being allowlisted into it — and a real
 * `LegLauncher`, which will spawn a CLI, belongs here too.
 *
 * ## Instance selection
 *
 * `config.instanceId` is the leg's declared instance and the default. When the
 * scheduler is on (`nomior.scheduler.enabled`, off by default) the runner asks
 * it to choose among the *enabled instances of the same driver* — so a
 * `codex-read` leg can move between two Codex accounts when one is rate
 * limited, and can never land on a Claude account. The scheduler stays
 * advisory: a `disabled` or `no-candidates` decision falls back to
 * `config.instanceId`, and the winning rule's reason travels back on
 * `LegRunResult.schedulerReason` for the review board to show.
 *
 * The scheduler key is `review:<repo>` (from `LegRunOptions.projectId`), so
 * sticky-per-project keeps one repo's legs on one account instead of rotating
 * accounts leg by leg.
 *
 * ## Launching — what is real and what is not
 *
 * Upstream has exactly two ways to run provider work, and neither is a
 * general one-shot:
 *
 * - `ProviderInstance.textGeneration` (`textGeneration/TextGeneration.ts`) is
 *   four fixed operations (commit message, PR content, branch name, thread
 *   title), each with its own prompt builder and output schema. It cannot
 *   carry a review brief.
 * - `ProviderInstance.adapter` (`provider/Services/ProviderAdapter.ts`) is
 *   session-shaped — `startSession`/`sendTurn`/event streams keyed by
 *   `ThreadId`. Running a leg through it would create a real user-visible
 *   thread per leg.
 *
 * So the seam is `LegLauncher`, and the default is
 * `LegLauncher.layerHandOff`: it launches nothing and returns a report with
 * `needsExternalReview: true`, which moves the job to `waiting-external` for a
 * human. That is the only safe no-op — a launcher that returned an empty
 * findings list would hand the deterministic gate a clean review nobody ran.
 *
 * The one step left to a real launch is a `LegLauncher` implementation that
 * spawns the instance's CLI with the brief and returns stdout, mirroring
 * `textGeneration/ClaudeTextGeneration.ts`'s `runClaudeJson` (ChildProcessSpawner +
 * `makeClaudeEnvironment(claudeSettings)` for Claude,
 * `textGeneration/CodexTextGeneration.ts` for `codex exec`). It needs a signed-in
 * CLI on the machine, which is why it is not the default and is not exercised
 * by any test here.
 *
 * @module nomior/review/LegRunnerLive
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { LegRunError, LegRunner, type LegRunResult, type ReviewLegConfig } from "../review/Legs.ts";
import { InstanceScheduler } from "../scheduler/InstanceScheduler.ts";
import type { SchedulerCandidate } from "../scheduler/Schemas.ts";

export interface LegLaunchInput {
  readonly config: ReviewLegConfig;
  readonly brief: string;
  /** The instance the scheduler settled on; may differ from `config.instanceId`. */
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
}

/**
 * The one place a review leg reaches a model. Swapping this layer is the whole
 * difference between the shipped no-op and a real review run.
 */
export class LegLauncher extends Context.Service<
  LegLauncher,
  {
    readonly launch: (input: LegLaunchInput) => Effect.Effect<LegRunResult, LegRunError>;
  }
>()("t3/nomior/wiring/LegRunnerLive/LegLauncher") {
  /**
   * Default: launch nothing, ask for a human. Emits a valid `LegReport` whose
   * `needsExternalReview` is true, so `ReviewEngine.processNext` parks the job
   * in `waiting-external` rather than letting the gate rule on a review that
   * never happened.
   */
  static readonly layerHandOff = Layer.succeed(
    LegLauncher,
    LegLauncher.of({
      launch: ({ instanceId, config }) =>
        Effect.succeed({
          rawOutput: JSON.stringify({
            findings: [],
            runtimeEvidence: [],
            needsExternalReview: true,
            note: `No leg launcher is configured; leg ${config.role} was not run on ${instanceId}.`,
          }),
          instanceId,
        }),
    }),
  );
}

export const make = Effect.gen(function* () {
  const scheduler = yield* InstanceScheduler;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const launcher = yield* LegLauncher;

  const run: LegRunner["Service"]["run"] = Effect.fn("LegRunnerLive.run")(
    function* (config, brief, options) {
      const declared = yield* registry.getInstance(config.instanceId);
      if (declared === undefined) {
        return yield* new LegRunError({
          legRole: config.role,
          detail: `Leg ${config.role} names provider instance '${config.instanceId}', which is not registered.`,
          rateLimited: false,
        });
      }
      if (!declared.enabled) {
        return yield* new LegRunError({
          legRole: config.role,
          detail: `Provider instance '${config.instanceId}' is disabled; enable it or point the ${config.role} leg elsewhere.`,
          rateLimited: false,
        });
      }

      let instanceId = declared.instanceId;
      let schedulerReason: string | undefined;

      if (options?.projectId !== undefined) {
        const instances = yield* registry.listInstances;
        // Same driver only: a leg's role and model belong to one provider, so
        // rerouting across drivers would silently change what ran.
        const candidates: ReadonlyArray<SchedulerCandidate> = instances
          .filter((instance) => instance.enabled && instance.driverKind === declared.driverKind)
          .map((instance) => ({ instanceId: instance.instanceId, driver: instance.driverKind }));
        const decision = yield* scheduler
          .pickForNewThread({ projectId: options.projectId, candidates })
          .pipe(
            Effect.catchTag(
              "PersistenceSqlError",
              // A scheduler read failure must not fail the review: fall back to
              // the declared instance and say so.
              (error) =>
                Effect.logWarning("nomior: scheduler unavailable for review leg", { error }).pipe(
                  Effect.as({ kind: "disabled" } as const),
                ),
            ),
          );
        if (decision.kind === "choice") {
          instanceId = decision.instanceId;
          schedulerReason = decision.reason;
        }
      }

      const chosen =
        instanceId === declared.instanceId ? declared : yield* registry.getInstance(instanceId);
      if (chosen === undefined || !chosen.enabled) {
        return yield* new LegRunError({
          legRole: config.role,
          detail: `Scheduler advised instance '${instanceId}', which is no longer usable.`,
          rateLimited: false,
        });
      }

      const result = yield* launcher.launch({
        config,
        brief,
        instanceId: chosen.instanceId,
        driverKind: chosen.driverKind,
      });
      return {
        ...result,
        instanceId: result.instanceId ?? chosen.instanceId,
        ...(schedulerReason === undefined ? {} : { schedulerReason }),
      };
    },
  );

  return LegRunner.of({ run });
});

/**
 * Requires `InstanceScheduler`, upstream's `ProviderInstanceRegistry`, and a
 * `LegLauncher` — `LegLauncher.layerHandOff` unless the deployment supplies a
 * real one.
 */
export const LegRunnerLive = Layer.effect(LegRunner, make);
