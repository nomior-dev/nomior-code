import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import type { NomiorScope } from "../context/Model.ts";
import {
  assembleSeedMeetings,
  checkBudget,
  checkReviewMemory,
  checkGateDecision,
  checkScopeIsolation,
  checkSchedulerDecision,
  formatSimulationReport,
  simulationExitCode,
  type SimulationReport,
} from "./simulate.ts";
import { seedMeetings } from "./scenario.ts";

const workCapsule: NomiorScope = { kind: "capsule", value: "nomior-code" };
const personalCapsule: NomiorScope = { kind: "capsule", value: "home-studio" };

describe("checkBudget", () => {
  it("passes a query that spent its budget exactly", () => {
    assert.deepStrictEqual(
      checkBudget([{ probeId: "p1", budgetTokens: 700, usedTokens: 700 }]),
      [],
    );
  });

  it("catches a query that spent more than it was given", () => {
    const violations = checkBudget([
      { probeId: "p1", budgetTokens: 700, usedTokens: 699 },
      { probeId: "p2", budgetTokens: 700, usedTokens: 701 },
    ]);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0]?.kind, "budget-exceeded");
    assert.include(violations[0]?.detail ?? "", "p2");
  });
});

describe("checkScopeIsolation", () => {
  const cited = (scopes: ReadonlyArray<NomiorScope>) => ({
    sourceId: "src-1",
    title: "Mix review — EP master",
    scopes,
  });

  it("passes when every cited source is bound to the queried scope", () => {
    assert.deepStrictEqual(
      checkScopeIsolation([
        { probeId: "p1", scope: workCapsule, citedSources: [cited([workCapsule])] },
      ]),
      [],
    );
  });

  it("catches a citation from another capsule", () => {
    const violations = checkScopeIsolation([
      { probeId: "p1", scope: workCapsule, citedSources: [cited([personalCapsule])] },
    ]);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0]?.kind, "scope-leak");
    assert.include(violations[0]?.detail ?? "", "Mix review");
  });

  it("does not accept a same-valued scope of a different kind", () => {
    const violations = checkScopeIsolation([
      {
        probeId: "p1",
        scope: workCapsule,
        citedSources: [cited([{ kind: "project", value: "nomior-code" }])],
      },
    ]);
    assert.strictEqual(violations.length, 1);
  });
});

describe("checkGateDecision", () => {
  it("allows approval when nothing blocking was found", () => {
    assert.deepStrictEqual(
      checkGateDecision([
        { jobId: "j1", severities: ["medium", "low"], decision: "approve-with-followups" },
      ]),
      [],
    );
  });

  it("catches an approval over a critical finding", () => {
    const violations = checkGateDecision([
      { jobId: "j1", severities: ["critical"], decision: "approve" },
    ]);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0]?.kind, "gate-approved-with-blocking-finding");
  });

  it("treats high as blocking too", () => {
    const violations = checkGateDecision([
      { jobId: "j1", severities: ["high"], decision: "approve-with-followups" },
    ]);
    assert.strictEqual(violations.length, 1);
  });

  it("accepts not-approved over a blocking finding", () => {
    assert.deepStrictEqual(
      checkGateDecision([{ jobId: "j1", severities: ["critical"], decision: "not-approved" }]),
      [],
    );
  });
});

describe("checkReviewMemory", () => {
  it("passes when every settled review's verdict is in memory", () => {
    assert.deepStrictEqual(
      checkReviewMemory({
        expectedTexts: ["Review verdict approve: clean run"],
        rememberedTexts: ["Review verdict approve: clean run", "A follow-up finding."],
      }),
      [],
    );
  });

  it("catches a settled review whose verdict never reached memory", () => {
    const violations = checkReviewMemory({
      expectedTexts: ["Review verdict not-approved: token in the repo"],
      rememberedTexts: ["Review verdict approve: clean run"],
    });
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0]?.kind, "review-memory-missing");
  });
});

describe("checkSchedulerDecision", () => {
  const choice = (instanceId: string) =>
    ({
      kind: "choice",
      instanceId: ProviderInstanceId.make(instanceId),
      rule: "headroom",
      reason: "most headroom",
    }) as const;

  it("passes when the pick still has headroom", () => {
    assert.deepStrictEqual(
      checkSchedulerDecision([
        {
          step: "1",
          decision: choice("inst-claude-main"),
          headroomByInstance: { "inst-claude-main": 40, "inst-claude-alt": 6 },
        },
      ]),
      [],
    );
  });

  it("catches a pick with no headroom while another instance had some", () => {
    const violations = checkSchedulerDecision([
      {
        step: "1",
        decision: choice("inst-claude-main"),
        headroomByInstance: { "inst-claude-main": 0, "inst-claude-alt": 55 },
      },
    ]);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0]?.kind, "scheduler-picked-exhausted-instance");
  });

  it("does not blame the scheduler when every candidate is exhausted", () => {
    assert.deepStrictEqual(
      checkSchedulerDecision([
        {
          step: "1",
          decision: choice("inst-claude-main"),
          headroomByInstance: { "inst-claude-main": 0, "inst-claude-alt": 0 },
        },
      ]),
      [],
    );
  });
});

describe("simulationExitCode", () => {
  const report = (violations: SimulationReport["violations"]): SimulationReport => ({
    evalTable: "",
    macroRecall: {},
    queries: [],
    reviews: [],
    schedulerSteps: [],
    meetings: { total: 0, linked: 0, needConfirmation: 0 },
    reviewMemories: 0,
    violations,
  });

  it("exits 0 only when nothing broke", () => {
    assert.strictEqual(simulationExitCode(report([])), 0);
  });

  it("exits 1 on a single violation, and names it in the report", () => {
    const failing = report([{ kind: "budget-exceeded", detail: "probe-x: used 900 of 700" }]);
    assert.strictEqual(simulationExitCode(failing), 1);
    const text = formatSimulationReport(failing);
    assert.include(text, "FAIL [budget-exceeded]");
    assert.notInclude(text, "PASS");
  });
});

describe("assembleSeedMeetings", () => {
  it("links every seeded meeting to the calendar event the scenario names", () => {
    const assembled = assembleSeedMeetings();
    assert.strictEqual(assembled.length, seedMeetings.length);
    for (const meeting of seedMeetings) {
      const match = assembled.find((entry) => entry.transcript?.sourceId === meeting.meetingId);
      assert.isDefined(match, `${meeting.meetingId} was not assembled`);
      assert.strictEqual(match.calendarEvent?.value, meeting.calendarEventId);
      assert.isFalse(match.needsConfirmation, `${meeting.meetingId} needs confirmation`);
    }
  });
});
