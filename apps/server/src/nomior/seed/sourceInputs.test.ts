import { assert, describe, it } from "@effect/vitest";

import { planChunks, renderSegment } from "../context/Chunking.ts";
import type { DecisionInput, EvidenceSpan, SourceInput } from "../context/Model.ts";
import { SEED_EXTERNAL_ID_PREFIX, seedMeetings, seedMemories } from "./scenario.ts";
import {
  candidateMemories,
  ingestableMemories,
  PERSONAL_CAPSULE_SCOPE,
  segmentSpans,
  seedSourceInputs,
  transcriptExternalId,
  WORK_CAPSULE_SCOPE,
  WORK_PROJECT_SCOPE,
} from "./sourceInputs.ts";

const evidenceSpans = (source: SourceInput): ReadonlyArray<EvidenceSpan> => [
  ...(source.decisions ?? []).flatMap((decision) =>
    decision.evidence === undefined ? [] : [decision.evidence],
  ),
  ...(source.tasks ?? []).flatMap((task) => (task.evidence === undefined ? [] : [task.evidence])),
];

describe("seedSourceInputs", () => {
  it("gives every source a unique, prefixed external id", () => {
    const ids = seedSourceInputs.map((source) => source.externalId);
    assert.isTrue(ids.every((id) => id !== undefined && id.startsWith(SEED_EXTERNAL_ID_PREFIX)));
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("scopes every source, and only work sources carry the project scope", () => {
    for (const source of seedSourceInputs) {
      assert.isAtLeast(source.scopes.length, 1, `${source.externalId ?? source.title} is unscoped`);
      const capsules = source.scopes.filter((scope) => scope.kind === "capsule");
      assert.strictEqual(capsules.length, 1, `${source.title} must sit in exactly one capsule`);
      const hasProject = source.scopes.some((scope) => scope.kind === "project");
      assert.strictEqual(
        hasProject,
        capsules[0]?.value === WORK_CAPSULE_SCOPE.value,
        `${source.title}: project scope must follow the work capsule`,
      );
    }
  });

  it("keeps the personal capsule out of the work scopes entirely", () => {
    const personal = seedSourceInputs.filter((source) =>
      source.scopes.some((scope) => scope.value === PERSONAL_CAPSULE_SCOPE.value),
    );
    assert.isAtLeast(personal.length, 1);
    for (const source of personal) {
      assert.isFalse(
        source.scopes.some(
          (scope) =>
            scope.value === WORK_CAPSULE_SCOPE.value || scope.value === WORK_PROJECT_SCOPE.value,
        ),
      );
    }
  });

  it("never ingests a memory that is still awaiting approval", () => {
    assert.isAtLeast(candidateMemories.length, 1);
    assert.strictEqual(candidateMemories.length + ingestableMemories.length, seedMemories.length);
    const texts = seedSourceInputs.flatMap((source) =>
      source.segments.map((segment) => segment.text),
    );
    for (const candidate of candidateMemories) {
      assert.isFalse(
        texts.some((text) => text.includes(candidate.text)),
        `${candidate.memoryId} is pending but was ingested`,
      );
    }
  });
});

describe("segmentSpans", () => {
  it("agrees with the canonical text planChunks renders", () => {
    for (const source of seedSourceInputs) {
      const { canonicalText } = planChunks(source.segments);
      const spans = segmentSpans(source.segments);
      assert.strictEqual(spans.length, source.segments.length);
      source.segments.forEach((segment, index) => {
        const span = spans[index]!;
        assert.strictEqual(
          canonicalText.slice(span.charStart, span.charEnd),
          renderSegment(segment),
          `${source.externalId ?? source.title} segment ${index} span is off`,
        );
      });
    }
  });
});

describe("seeded evidence", () => {
  it("points every decision and task at real text in its own source", () => {
    let checked = 0;
    for (const source of seedSourceInputs) {
      const { canonicalText } = planChunks(source.segments);
      for (const span of evidenceSpans(source)) {
        assert.isBelow(span.charStart, span.charEnd);
        assert.isAtMost(span.charEnd, canonicalText.length);
        assert.isNotEmpty(canonicalText.slice(span.charStart, span.charEnd).trim());
        checked += 1;
      }
    }
    // A silent zero here would make the assertions above vacuous.
    assert.isAtLeast(checked, seedMeetings.length);
  });

  it("cites the turn the decision was actually taken in", () => {
    for (const meeting of seedMeetings) {
      const source = seedSourceInputs.find(
        (candidate) => candidate.externalId === transcriptExternalId(meeting.meetingId),
      );
      assert.isDefined(source, `no transcript source for ${meeting.meetingId}`);
      const { canonicalText } = planChunks(source.segments);
      for (const decision of meeting.decisions) {
        const ingested: DecisionInput | undefined = (source.decisions ?? []).find(
          (input) => input.statement === decision.statement,
        );
        assert.isDefined(
          ingested,
          `${meeting.meetingId}: "${decision.statement}" was not ingested`,
        );
        const span: EvidenceSpan | undefined = ingested.evidence;
        assert.isDefined(span, `${meeting.meetingId}: "${decision.statement}" has no evidence`);
        assert.include(
          canonicalText.slice(span.charStart, span.charEnd),
          meeting.transcript[decision.turnIndex]!.text,
        );
      }
    }
  });
});
