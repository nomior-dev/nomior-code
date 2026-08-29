import { describe, expect, it } from "vite-plus/test";

import { createFixtureNomiorPort } from "./fixtures";
import {
  canRequestManualReview,
  groupReviewJobs,
  isReviewSort,
  pullRequestUrl,
  REVIEW_COLUMNS,
  REVIEW_SORTS,
  reviewStatusLabel,
  sortReviewJobs,
} from "./reviewBoard.logic";
import type { ReviewJob, ReviewJobDetail } from "./types";

const job = (overrides: Partial<ReviewJob>): ReviewJob => ({
  id: "rev-1",
  repo: "nomior-dev/nomior-code",
  pullRequestNumber: 1,
  pullRequestTitle: "test",
  status: "queue",
  updatedAt: "2026-08-29T10:00:00.000Z",
  ...overrides,
});

const detail = (overrides: Partial<ReviewJobDetail>): ReviewJobDetail => ({
  ...job({}),
  pullRequestState: "open",
  riskTier: "low",
  verdict: null,
  severityCounts: { blocker: 0, major: 0, minor: 0 },
  manualReviewRequested: false,
  headSha: "abc1234",
  createdAt: "2026-08-29T09:00:00.000Z",
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

  it("applies the board's sort inside every column, not just the first", () => {
    const early = job({ id: "a", updatedAt: "2026-08-29T08:00:00.000Z" });
    const late = job({ id: "b", updatedAt: "2026-08-29T12:00:00.000Z" });
    const grouped = groupReviewJobs(
      [early, late, { ...early, id: "c", status: "reviewing" }],
      "oldest",
    );
    expect(grouped.get("queue")?.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(grouped.get("reviewing")?.map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("sortReviewJobs", () => {
  const jobs = [
    job({
      id: "a",
      repo: "nomior-dev/nomior-invest",
      pullRequestNumber: 9,
      updatedAt: "2026-08-29T08:00:00.000Z",
    }),
    job({
      id: "b",
      repo: "nomior-dev/nomior-code",
      pullRequestNumber: 42,
      updatedAt: "2026-08-29T12:00:00.000Z",
    }),
    job({
      id: "c",
      repo: "nomior-dev/nomior-code",
      pullRequestNumber: 7,
      updatedAt: "2026-08-29T10:00:00.000Z",
    }),
  ];

  it("offers only the orders it can apply", () => {
    for (const sort of REVIEW_SORTS) expect(isReviewSort(sort.id)).toBe(true);
    expect(isReviewSort("risk")).toBe(false);
    expect(isReviewSort(null)).toBe(false);
  });

  it("orders by time in both directions", () => {
    expect(sortReviewJobs(jobs, "recent").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(sortReviewJobs(jobs, "oldest").map((entry) => entry.id)).toEqual(["a", "c", "b"]);
  });

  it("puts a project's cards in one run, by pull request number", () => {
    expect(sortReviewJobs(jobs, "project").map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("leaves the caller's array alone", () => {
    const before = jobs.map((entry) => entry.id);
    sortReviewJobs(jobs, "oldest");
    expect(jobs.map((entry) => entry.id)).toEqual(before);
  });
});

describe("naming a job's status and pull request", () => {
  it("uses the board's own column titles", () => {
    expect(reviewStatusLabel("waiting-external")).toBe("Waiting external");
    expect(reviewStatusLabel("queue")).toBe("Queue");
  });

  it("points at the pull request on the forge", () => {
    expect(pullRequestUrl({ repo: "nomior-dev/nomior-code", pullRequestNumber: 412 })).toBe(
      "https://github.com/nomior-dev/nomior-code/pull/412",
    );
  });
});

describe("canRequestManualReview", () => {
  it("allows queue and reviewing jobs once", () => {
    expect(canRequestManualReview(detail({ status: "queue" }))).toBe(true);
    expect(canRequestManualReview(detail({ status: "reviewing" }))).toBe(true);
    expect(canRequestManualReview(detail({ status: "queue", manualReviewRequested: true }))).toBe(
      false,
    );
    expect(canRequestManualReview(detail({ status: "approved" }))).toBe(false);
  });
});

describe("fixture port — review jobs", () => {
  const port = () => createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));

  it("moves a job to waiting-external on manual review request", async () => {
    const fixture = port();
    const before = await fixture.listReviewJobs();
    const requestable = await Promise.all(
      before.map((entry) => fixture.getReviewJob(entry.id).then(canRequestManualReview)),
    );
    const target = before[requestable.indexOf(true)];
    expect(target).toBeDefined();
    await fixture.requestManualReview(target!.id);
    const moved = await fixture.getReviewJob(target!.id);
    expect(moved.status).toBe("waiting-external");
    expect(moved.manualReviewRequested).toBe(true);
  });

  it("lists open pull requests only, and still resolves a settled one by id", async () => {
    const fixture = port();
    const listed = await fixture.listReviewJobs();
    const states = await Promise.all(
      listed.map((entry) => fixture.getReviewJob(entry.id).then((one) => one.pullRequestState)),
    );
    expect(states.every((state) => state === "open")).toBe(true);
    // The sample data carries settled pull requests precisely so this holds.
    const merged = await fixture.getReviewJob("rev-107");
    expect(merged.pullRequestState).toBe("merged");
    expect(listed.some((entry) => entry.id === "rev-107")).toBe(false);
  });
});
