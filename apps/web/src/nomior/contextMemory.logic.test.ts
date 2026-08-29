import { describe, expect, it } from "vite-plus/test";

import {
  applyCandidateResolution,
  formatSourceDate,
  orderMemoryCandidates,
  pendingCandidateCount,
  sourceKindLabel,
} from "./contextMemory.logic";
import { createFixtureNomiorPort } from "./fixtures";
import type { MemoryCandidate } from "./types";

const candidate = (overrides: Partial<MemoryCandidate>): MemoryCandidate => ({
  id: "mem-1",
  text: "fact",
  source: "somewhere",
  capturedAt: "2026-08-29T10:00:00.000Z",
  status: "pending",
  ...overrides,
});

describe("sourceKindLabel", () => {
  it("labels every source kind", () => {
    expect(sourceKindLabel("meeting")).toBe("Meeting");
    expect(sourceKindLabel("decision")).toBe("Decision");
    expect(sourceKindLabel("memory")).toBe("Memory");
    expect(sourceKindLabel("document")).toBe("Document");
    expect(sourceKindLabel("mail")).toBe("Email");
    expect(sourceKindLabel("event")).toBe("Event");
  });
});

describe("formatSourceDate", () => {
  it("renders an ISO day in en-US as a short date", () => {
    expect(formatSourceDate("2026-08-24", "en-US")).toBe("Aug 24, 2026");
  });

  it("falls back to the raw string for garbage input", () => {
    expect(formatSourceDate("not-a-date", "en-US")).toBe("not-a-date");
  });
});

describe("memory candidate ordering and resolution", () => {
  it("keeps pending candidates above resolved ones without dropping rows", () => {
    const list = [
      candidate({ id: "a", status: "approved" }),
      candidate({ id: "b" }),
      candidate({ id: "c", status: "rejected" }),
    ];
    expect(orderMemoryCandidates(list).map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  it("resolves exactly the addressed candidate", () => {
    const list = [candidate({ id: "a" }), candidate({ id: "b" })];
    const resolved = applyCandidateResolution(list, "a", "rejected");
    expect(resolved.find((entry) => entry.id === "a")?.status).toBe("rejected");
    expect(resolved.find((entry) => entry.id === "b")?.status).toBe("pending");
    expect(pendingCandidateCount(resolved)).toBe(1);
  });
});

describe("fixture port — context search and memory", () => {
  it("returns cited snippets ranked by score for a matching query", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    const results = await port.searchContext("scheduler");
    expect(results.length).toBeGreaterThan(0);
    const scores = results.map((entry) => entry.score);
    expect(scores).toEqual([...scores].toSorted((left, right) => right - left));
    for (const snippet of results) {
      expect(snippet.sourceTitle.length).toBeGreaterThan(0);
      expect(snippet.sourceDate.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for a blank query", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    expect(await port.searchContext("   ")).toEqual([]);
  });

  it("never auto-promotes: candidates stay pending until an explicit decision", async () => {
    const port = createFixtureNomiorPort(new Date("2026-08-29T12:00:00.000Z"));
    const before = await port.listMemoryCandidates();
    expect(before.every((entry) => entry.status === "pending")).toBe(true);
    await port.resolveMemoryCandidate(before[0]!.id, "approved");
    const after = await port.listMemoryCandidates();
    expect(after.find((entry) => entry.id === before[0]!.id)?.status).toBe("approved");
    expect(after.filter((entry) => entry.status === "pending")).toHaveLength(before.length - 1);
  });
});
