import { describe, expect, it } from "vite-plus/test";

import { DEMO_GIFS } from "./record-demo-gifs.ts";

describe("demo GIF manifest", () => {
  it("uses unique .gif output names", () => {
    const names = DEMO_GIFS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.endsWith(".gif")).toBe(true);
  });

  it("keeps every demo in the landing page's 16:10 frame", () => {
    for (const spec of DEMO_GIFS) {
      expect(spec.aspect).toEqual([16, 10]);
    }
  });

  it("anchors every scenario to an in-app route", () => {
    for (const spec of DEMO_GIFS) {
      expect(spec.route.startsWith("/")).toBe(true);
      expect(spec.scenario.length).toBeGreaterThan(20);
    }
  });
});
