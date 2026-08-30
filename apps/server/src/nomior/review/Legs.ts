/**
 * Review legs: configurable roles bound to a provider instance + model.
 *
 * Legs are described by data (`ReviewLegConfig`); execution is behind the
 * `LegRunner` port so the engine core and its tests never talk to a real
 * provider. Brief building follows the Codex developer-instructions gating
 * pattern: a brief must never describe a tool that is not attached
 * to that leg.
 */
import { ProviderInstanceId, TrimmedNonEmptyString, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { PlaybookPresence } from "./Playbook.ts";
import { LegReport, ReviewLegRole, type ParsedLegResult } from "./Schemas.ts";

/**
 * Tools a leg may have attached. A closed catalog on purpose: brief text is
 * scanned against it, so an unknown tool cannot slip into a brief unnoticed.
 */
export const ReviewLegTool = Schema.Literals(["shell", "git-read", "web-search", "preview"]);
export type ReviewLegTool = typeof ReviewLegTool.Type;

export const ReviewLegConfig = Schema.Struct({
  role: ReviewLegRole,
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  attachedTools: Schema.Array(ReviewLegTool),
});
export type ReviewLegConfig = typeof ReviewLegConfig.Type;

/** Everything a brief may say about a tool, keyed by catalog name. */
const TOOL_DESCRIPTIONS: Record<ReviewLegTool, string> = {
  shell: "shell — run the repo's own verification commands (tests, typecheck, build)",
  "git-read": "git-read — inspect history, blame, and diffs beyond the change under review",
  "web-search":
    "web-search — check current external APIs and advisories when the diff depends on them",
  preview: "preview — drive the app preview to exercise the change end to end",
};

const ROLE_MISSIONS: Record<ReviewLegRole, string> = {
  "claude-verify":
    "You are the verification leg. Confirm the change does what it claims by exercising it, and report findings only when you can state the failure scenario.",
  "codex-read":
    "You are the reading leg. Review the diff and surrounding code for correctness, contract violations, and missed edge cases. Judge only what the text of the code supports.",
  security:
    "You are the security leg. Review the change for injection, secret exposure, privilege escalation, and unsafe data flows. Prefer few, well-evidenced findings.",
};

export interface LegBriefInput {
  readonly playbook: PlaybookPresence;
  /** Broker context packet for this leg; null when none was assembled. */
  readonly contextPacket: string | null;
  readonly changeSummary: string;
}

/**
 * Build the instruction brief for one leg. Tool text is generated
 * exclusively from `config.attachedTools`, so a tool that is not attached is
 * never mentioned — asserted by `findUnattachedToolMentions` in tests.
 */
export const buildLegBrief = (config: ReviewLegConfig, input: LegBriefInput): string => {
  const sections: Array<string> = [ROLE_MISSIONS[config.role]];

  sections.push(`## Change under review\n${input.changeSummary}`);

  if (input.playbook.kind === "present") {
    sections.push(`## Repo context\n${input.playbook.playbook.context}`);
    sections.push(`## The bar\n${input.playbook.playbook.bar}`);
    // Verification steps are actionable only for a leg that can execute
    // them; a tool-less leg gets the bar but not instructions it cannot run.
    if (config.attachedTools.includes("shell")) {
      sections.push(`## How to verify\n${input.playbook.playbook.verify}`);
    }
  } else {
    sections.push(
      "## The bar\nThis repo has no review playbook. Confidence is reduced: report findings, but do not treat anything as verified.",
    );
  }

  if (input.contextPacket !== null) {
    sections.push(`## Context packet\n${input.contextPacket}`);
  }

  sections.push(
    config.attachedTools.length === 0
      ? "## Tools\nYou have no tools attached. Work only from the material above."
      : `## Tools\nYou may use exactly these tools:\n${config.attachedTools
          .map((tool) => `- ${TOOL_DESCRIPTIONS[tool]}`)
          .join("\n")}`,
  );

  sections.push(
    [
      "## Output",
      "Reply with exactly one JSON object and nothing after it:",
      '{"findings": [{"severity": "critical|high|medium|low|info", "summary": "...", "file": "...", "line": 1}],',
      ' "runtimeEvidence": [{"kind": "tests-run|build-passed|typecheck-passed|live-probe|ci-green", "detail": "..."}],',
      ' "needsExternalReview": false}',
      "Report runtimeEvidence only for verification you actually performed.",
      "Set needsExternalReview only when the call is not yours to make: the change turns on intent, a product tradeoff, or a rule this repo has never written down. Uncertainty is not escalation — if you can name the risk, it is a finding. Asking for a human while reporting a blocking finding is ignored, because the gate rules first.",
    ].join("\n"),
  );

  return sections.join("\n\n");
};

/**
 * Catalog tools mentioned by a brief that are NOT attached to the leg.
 * Empty for every brief `buildLegBrief` produces; exported so tests (and
 * future custom-brief paths) can enforce the invariant.
 */
export const findUnattachedToolMentions = (
  brief: string,
  attachedTools: ReadonlyArray<ReviewLegTool>,
): ReadonlyArray<ReviewLegTool> =>
  ReviewLegTool.literals.filter(
    (tool) => !attachedTools.includes(tool) && new RegExp(`\\b${tool}\\b`).test(brief),
  );

const decodeLegReport = Schema.decodeUnknownOption(LegReport);

/**
 * Parse a leg's raw output into a typed result. Anything that does not
 * contain a decodable report object is `unparseable` — a first-class outcome
 * the gate fails closed on, never a dropped review.
 */
export const parseLegOutput = (role: ReviewLegRole, rawOutput: string): ParsedLegResult => {
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { legRole: role, outcome: "unparseable", detail: "no JSON object in leg output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput.slice(start, end + 1));
  } catch {
    return { legRole: role, outcome: "unparseable", detail: "leg output JSON did not parse" };
  }

  const report = decodeLegReport(parsed);
  if (Option.isNone(report)) {
    return {
      legRole: role,
      outcome: "unparseable",
      detail: "leg output JSON did not match the report schema",
    };
  }
  return { legRole: role, outcome: "parsed", report: report.value };
};

export class LegRunError extends Schema.TaggedErrorClass<LegRunError>()("NomiorLegRunError", {
  legRole: ReviewLegRole,
  detail: Schema.String,
  /** Rate-limit failures cool down much longer than ordinary failures. */
  rateLimited: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface LegRunResult {
  readonly rawOutput: string;
  /**
   * The instance the leg actually ran on. Differs from `config.instanceId`
   * when the scheduler advised another instance of the same driver; absent
   * when the runner does not select instances (test fakes).
   */
  readonly instanceId?: ProviderInstanceId | undefined;
  /** The scheduler's reason for that instance, verbatim, for the UI. */
  readonly schedulerReason?: string | undefined;
}

export interface LegRunOptions {
  /**
   * Scheduler key for instance selection. The engine passes one key per repo
   * so a repo's reviews stay on the instance they used last (sticky) instead
   * of rotating an account per leg.
   */
  readonly projectId?: ProjectId | undefined;
}

/**
 * Scheduler key for a repo's reviews. Namespaced so a repo name can never
 * collide with a real project id in `nomior_scheduler_assignments`.
 */
export const reviewSchedulerProjectKey = (repo: string): string => `review:${repo}`;

/**
 * Execution port for review legs. The engine core depends only on this
 * interface; production wiring binds it to `LegRunnerLive` (scheduler-selected
 * instance + `LegLauncher`), tests bind fakes.
 *
 * `options` is optional so a two-argument fake still satisfies the port.
 */
export class LegRunner extends Context.Service<
  LegRunner,
  {
    readonly run: (
      config: ReviewLegConfig,
      brief: string,
      options?: LegRunOptions,
    ) => Effect.Effect<LegRunResult, LegRunError>;
  }
>()("t3/nomior/review/Legs/LegRunner") {}
