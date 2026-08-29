import { describe, expect, it } from "vite-plus/test";

import { formatSourceDate, sourceKindLabel } from "./contextMemory.logic";
import { createFixtureNomiorPort } from "./fixtures";

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

describe("fixture port — context search", () => {
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
});
