import { describe, expect, it } from "vite-plus/test";

import { createFixtureNomiorPort } from "./fixtures";
import {
  canRequestManualReview,
  groupReviewJobs,
  REVIEW_COLUMNS,
  riskTierTone,
  severityChips,
} from "./reviewBoard.logic";
import type { ReviewJob } from "./types";

const job = (overrides: Partial<ReviewJob>): ReviewJob => ({
  id: "rev-1",
  repo: "nomior-dev/nomior-code",
  pullRequestNumber: 1,
  pullRequestTitle: "test",
  riskTier: "low",
  status: "queue",
  verdict: null,
  severityCounts: { blocker: 0, major: 0, minor: 0 },
  manualReviewRequested: false,
  updatedAt: "2026-08-29T10:00:00.000Z",
  ...overrides,
});

describe("groupReviewJobs", () => {
  it("keeps every board column present even when empty", () => {
    const grouped = groupReviewJobs([]);
    expect([...grouped.keys()]).toEqual(REVIEW_COLUMNS.map((column) => column.id));
    for (const jobs of grouped.values()) expect(jobs).toEqual([]);
  });

  it("groups by status and orders newest first inside a column", () => {
    const older = job({ id: "a", updatedAt: "2026-08-29T08:00:00.000Z" });
    const newer = job({ id: "b", updatedAt: "2026-08-29T12:00:00.000Z" });
    const reviewing = job({ id: "c", status: "reviewing" });
    const grouped = groupReviewJobs([older, reviewing, newer]);
    expect(grouped.get("queue")?.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(grouped.get("reviewing")?.map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("severityChips", () => {
  it("emits only non-zero severities in blocker → major → minor order", () => {
    expect(severityChips({ blocker: 0, major: 0, minor: 0 })).toEqual([]);
    expect(severityChips({ blocker: 1, major: 0, minor: 3 })).toEqual([
      { label: "blocker", count: 1, tone: "error" },
      { label: "minor", count: 3, tone: "secondary" },
    ]);
  });
});

describe("riskTierTone", () => {
  it("escalates tone with risk", () => {
    expect(riskTierTone("low")).toBe("secondary");
    expect(riskTierTone("medium")).toBe("warning");
    expect(riskTierTone("high")).toBe("error");
  });
});

describe("canRequestManualReview", () => {
  it("allows queue and reviewing jobs once", () => {
    expect(canRequestManualReview(job({ status: "queue" }))).toBe(true);
    expect(canRequestManualReview(job({ status: "reviewing" }))).toBe(true);
    expect(canRequestManualReview(job({ status: "queue", manualReviewRequested: true }))).toBe(
      false,
    );
    expect(canRequestManualReview(job({ status: "approved" }))).toBe(false);
  });
});

describe("fixture port — review jobs", () => {
  it("moves a job to waiting-external on manual review request", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    const before = await port.listReviewJobs();
    const target = before.find((entry) => canRequestManualReview(entry));
    expect(target).toBeDefined();
    await port.requestManualReview(target!.id);
    const after = await port.listReviewJobs();
    const moved = after.find((entry) => entry.id === target!.id);
    expect(moved?.status).toBe("waiting-external");
    expect(moved?.manualReviewRequested).toBe(true);
  });
});
