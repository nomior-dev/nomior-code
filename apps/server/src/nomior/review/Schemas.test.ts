import { assert, describe, it } from "@effect/vitest";

import { REVIEW_JOB_TRANSITIONS, ReviewJobStatus, isAllowedTransition } from "./Schemas.ts";

describe("review job state machine", () => {
  it("pins the exact transition map", () => {
    assert.deepStrictEqual(REVIEW_JOB_TRANSITIONS, {
      queued: ["reviewing"],
      reviewing: ["approved", "not-approved", "waiting-external", "queued", "failed"],
      "waiting-external": ["approved", "not-approved"],
      approved: [],
      "not-approved": [],
      failed: [],
    });
  });

  it("terminal states allow no transitions at all", () => {
    for (const from of ["approved", "not-approved", "failed"] as const) {
      for (const to of ReviewJobStatus.literals) {
        assert.isFalse(isAllowedTransition(from, to), `${from} -> ${to}`);
      }
    }
  });

  it("every status is covered by the transition map", () => {
    assert.deepStrictEqual(
      Object.keys(REVIEW_JOB_TRANSITIONS).sort(),
      [...ReviewJobStatus.literals].sort(),
    );
  });
});
