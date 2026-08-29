/**
 * Exhaustive unit tests for the deterministic verdict gate — the
 * safety-critical piece of the review engine. Every rule and every
 * fail-closed path is pinned here.
 */
import { assert, describe, it } from "@effect/vitest";

import { evaluateGate, type GateInput } from "./Gate.ts";
import type { PlaybookPresence } from "./Playbook.ts";
import type {
  FindingSeverity,
  LegFinding,
  LegReport,
  ParsedLegResult,
  RuntimeEvidence,
} from "./Schemas.ts";

const playbook: PlaybookPresence = {
  kind: "present",
  playbook: { verify: "v", context: "c", bar: "b" },
};
const noPlaybook: PlaybookPresence = { kind: "absent" };

const evidence: RuntimeEvidence = { kind: "tests-run", detail: "vitest 42 passed" };

const finding = (severity: FindingSeverity, summary = `a ${severity} finding`): LegFinding => ({
  severity,
  summary,
});

const parsedLeg = (report: Partial<LegReport>): ParsedLegResult => ({
  legRole: "codex-read",
  outcome: "parsed",
  report: { findings: [], runtimeEvidence: [], needsExternalReview: false, ...report },
});

const unparseableLeg: ParsedLegResult = {
  legRole: "claude-verify",
  outcome: "unparseable",
  detail: "no JSON object in leg output",
};

const cleanVerifiedLeg = parsedLeg({ runtimeEvidence: [evidence] });

describe("evaluateGate", () => {
  it("fails closed when no legs ran", () => {
    const verdict = evaluateGate({ legs: [], playbook });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.match(verdict.reasons.join(" "), /No review legs ran/);
  });

  it("fails closed on an unparseable leg, even with a playbook and evidence", () => {
    const verdict = evaluateGate({ legs: [cleanVerifiedLeg, unparseableLeg], playbook });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.match(verdict.reasons.join(" "), /unparseable/);
  });

  it("blocks on any critical finding", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({ findings: [finding("critical")], runtimeEvidence: [evidence] })],
      playbook,
    });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.match(verdict.reasons.join(" "), /critical/);
  });

  it("blocks on any high finding", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({ findings: [finding("high")], runtimeEvidence: [evidence] })],
      playbook,
    });
    assert.strictEqual(verdict.decision, "not-approved");
  });

  it("one blocking finding among many legs blocks the whole review", () => {
    const verdict = evaluateGate({
      legs: [
        cleanVerifiedLeg,
        parsedLeg({ findings: [finding("low"), finding("critical")] }),
        parsedLeg({}),
      ],
      playbook,
    });
    assert.strictEqual(verdict.decision, "not-approved");
    // Non-blocking findings still surface as followups next to the block.
    assert.strictEqual(verdict.followups.length, 1);
    assert.strictEqual(verdict.followups[0]?.severity, "low");
  });

  it("approves with followups on medium findings", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({ findings: [finding("medium")], runtimeEvidence: [evidence] })],
      playbook,
    });
    assert.strictEqual(verdict.decision, "approve-with-followups");
    assert.strictEqual(verdict.followups.length, 1);
  });

  it("approves with followups on low findings", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({ findings: [finding("low")], runtimeEvidence: [evidence] })],
      playbook,
    });
    assert.strictEqual(verdict.decision, "approve-with-followups");
  });

  it("info findings neither block nor create followups", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({ findings: [finding("info")], runtimeEvidence: [evidence] })],
      playbook,
    });
    assert.strictEqual(verdict.decision, "approve");
    assert.deepStrictEqual(verdict.followups, []);
  });

  it("approves a clean, verified review with a playbook", () => {
    const verdict = evaluateGate({ legs: [cleanVerifiedLeg], playbook });
    assert.strictEqual(verdict.decision, "approve");
  });

  it("withholds approval without a playbook", () => {
    const verdict = evaluateGate({ legs: [cleanVerifiedLeg], playbook: noPlaybook });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.match(verdict.reasons.join(" "), /playbook/i);
  });

  it("withholds approval without runtime evidence", () => {
    const verdict = evaluateGate({ legs: [parsedLeg({})], playbook });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.match(verdict.reasons.join(" "), /runtime evidence/i);
  });

  it("withholds approval-with-followups under the same preconditions", () => {
    const noEvidence = evaluateGate({
      legs: [parsedLeg({ findings: [finding("medium")] })],
      playbook,
    });
    assert.strictEqual(noEvidence.decision, "not-approved");

    const withoutPlaybook = evaluateGate({
      legs: [parsedLeg({ findings: [finding("medium")], runtimeEvidence: [evidence] })],
      playbook: noPlaybook,
    });
    assert.strictEqual(withoutPlaybook.decision, "not-approved");
  });

  it("names both missing preconditions at once", () => {
    const verdict = evaluateGate({ legs: [parsedLeg({})], playbook: noPlaybook });
    assert.strictEqual(verdict.decision, "not-approved");
    assert.strictEqual(verdict.reasons.length, 2);
  });

  it("accepts evidence contributed by any leg", () => {
    const verdict = evaluateGate({
      legs: [parsedLeg({}), cleanVerifiedLeg],
      playbook,
    });
    assert.strictEqual(verdict.decision, "approve");
  });

  it("every severity has a pinned outcome", () => {
    const expected: Record<FindingSeverity, string> = {
      critical: "not-approved",
      high: "not-approved",
      medium: "approve-with-followups",
      low: "approve-with-followups",
      info: "approve",
    };
    for (const [severity, decision] of Object.entries(expected)) {
      const verdict = evaluateGate({
        legs: [
          parsedLeg({
            findings: [finding(severity as FindingSeverity)],
            runtimeEvidence: [evidence],
          }),
        ],
        playbook,
      });
      assert.strictEqual(verdict.decision, decision, `severity=${severity}`);
    }
  });

  it("is deterministic: identical input yields an identical verdict", () => {
    const input: GateInput = {
      legs: [
        parsedLeg({ findings: [finding("medium"), finding("info")], runtimeEvidence: [evidence] }),
      ],
      playbook,
    };
    assert.deepStrictEqual(evaluateGate(input), evaluateGate(input));
  });
});
