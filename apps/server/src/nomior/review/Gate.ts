/**
 * The deterministic verdict gate — the safety-critical piece of the review
 * engine. A pure function from parsed leg results to a verdict; no model
 * output can approve a change on its own phrasing, only through this gate.
 *
 * Fail-closed rules:
 * - no legs ran → not approved (nothing was reviewed);
 * - any unparseable leg → treated as a high finding → not approved;
 * - any critical/high finding → not approved;
 * - only medium/low findings → approve with followups;
 * - no findings → approve;
 * - additionally, approving (with or without followups) requires a present
 *   playbook AND at least one piece of real runtime evidence.
 */
import type { PlaybookPresence } from "./Playbook.ts";
import type {
  FindingSeverity,
  GateVerdict,
  LegFinding,
  ParsedLegResult,
  RuntimeEvidence,
} from "./Schemas.ts";

export interface GateInput {
  readonly legs: ReadonlyArray<ParsedLegResult>;
  readonly playbook: PlaybookPresence;
}

type SeverityImpact = "blocking" | "followup" | "none";

const severityImpact = (severity: FindingSeverity): SeverityImpact => {
  switch (severity) {
    case "critical":
    case "high":
      return "blocking";
    case "medium":
    case "low":
      return "followup";
    case "info":
      return "none";
    default: {
      // Exhaustiveness: a new severity literal fails typecheck here. At
      // runtime an unknown value still fails closed.
      severity satisfies never;
      return "blocking";
    }
  }
};

const collectRuntimeEvidence = (
  legs: ReadonlyArray<ParsedLegResult>,
): ReadonlyArray<RuntimeEvidence> =>
  legs.flatMap((leg) => (leg.outcome === "parsed" ? leg.report.runtimeEvidence : []));

/**
 * Evaluate the gate. Pure and deterministic: same input, same verdict.
 */
export const evaluateGate = (input: GateInput): GateVerdict => {
  const reasons: Array<string> = [];
  const blocking: Array<string> = [];
  const followups: Array<LegFinding> = [];

  if (input.legs.length === 0) {
    return {
      decision: "not-approved",
      reasons: ["No review legs ran; nothing was reviewed."],
      followups: [],
    };
  }

  for (const leg of input.legs) {
    if (leg.outcome === "unparseable") {
      // Fail closed: output we cannot read is treated as a high finding.
      blocking.push(`Leg ${leg.legRole} produced unparseable output (${leg.detail}).`);
      continue;
    }
    for (const finding of leg.report.findings) {
      switch (severityImpact(finding.severity)) {
        case "blocking":
          blocking.push(`Leg ${leg.legRole}: [${finding.severity}] ${finding.summary}`);
          break;
        case "followup":
          followups.push(finding);
          break;
        case "none":
          break;
      }
    }
  }

  if (blocking.length > 0) {
    return { decision: "not-approved", reasons: blocking, followups };
  }

  // Approval preconditions: judgment (a playbook) and proof (runtime
  // evidence). Missing either downgrades a clean review to not-approved.
  if (input.playbook.kind !== "present") {
    reasons.push("No playbook for this repo: confidence reduced, approval withheld.");
  }
  const evidence = collectRuntimeEvidence(input.legs);
  if (evidence.length === 0) {
    reasons.push("No runtime evidence was reported: nothing was actually exercised.");
  }
  if (reasons.length > 0) {
    return { decision: "not-approved", reasons, followups };
  }

  if (followups.length > 0) {
    return {
      decision: "approve-with-followups",
      reasons: [`Approved with ${followups.length} non-blocking finding(s) to follow up.`],
      followups,
    };
  }

  return {
    decision: "approve",
    reasons: ["No findings; playbook satisfied with runtime evidence."],
    followups: [],
  };
};
