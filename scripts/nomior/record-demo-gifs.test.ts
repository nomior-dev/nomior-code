import { describe, expect, it } from "vite-plus/test";

import {
  appUnreachableMessage,
  DEMO_GIFS,
  DemoRecorderError,
  ffmpegGifArgs,
  GIF_COLORS,
  GIF_FPS,
  GIF_WIDTH,
  missingFfmpegMessage,
  missingPlaywrightMessage,
  parseCliOptions,
  selectSpecs,
  stepFailureMessage,
} from "./record-demo-gifs.ts";

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

  it("covers the four flows PLAN.md names", () => {
    expect(DEMO_GIFS.map((spec) => spec.name)).toEqual([
      "cited-answer.gif",
      "calendar-week.gif",
      "scheduler-switch.gif",
      "review-board.gif",
    ]);
  });

  it("opens every scenario by waiting for something on screen", () => {
    for (const spec of DEMO_GIFS) {
      expect(spec.steps[0]?.kind).toBe("waitFor");
    }
  });

  it("never ends on a bare hold-free step, so the last state is readable", () => {
    for (const spec of DEMO_GIFS) {
      const last = spec.steps.at(-1);
      expect(last?.kind).toBe("hold");
      if (last?.kind === "hold") expect(last.ms).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe("parseCliOptions", () => {
  it("defaults to the local dev server and the landing's demo dir", () => {
    const options = parseCliOptions([], {});
    expect(options.baseUrl).toBe("http://127.0.0.1:3000");
    expect(options.outDir.endsWith("apps/nomior-landing/public/demos")).toBe(true);
    expect(options.only.size).toBe(0);
    expect(options.headed).toBe(false);
  });

  it("takes the base URL from the environment and strips trailing slashes", () => {
    const options = parseCliOptions([], { NOMIOR_DEMO_BASE_URL: "http://localhost:4000///" });
    expect(options.baseUrl).toBe("http://localhost:4000");
  });

  it("lets a flag beat the environment", () => {
    const options = parseCliOptions(["--base-url", "http://box:3000"], {
      NOMIOR_DEMO_BASE_URL: "http://localhost:4000",
    });
    expect(options.baseUrl).toBe("http://box:3000");
  });

  it("accepts --only with or without the extension", () => {
    const options = parseCliOptions(["--only", "review-board,cited-answer.gif"], {});
    expect([...options.only].sort()).toEqual(["cited-answer.gif", "review-board.gif"]);
    expect(selectSpecs(options.only).map((spec) => spec.name)).toEqual([
      "cited-answer.gif",
      "review-board.gif",
    ]);
  });

  it("rejects an unknown demo name instead of silently recording nothing", () => {
    expect(() => parseCliOptions(["--only", "nope"], {})).toThrow(DemoRecorderError);
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliOptions(["--fast"], {})).toThrow(/Unknown option --fast/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseCliOptions(["--base-url"], {})).toThrow(/needs a value/);
  });
});

describe("selectSpecs", () => {
  it("records everything when nothing is filtered", () => {
    expect(selectSpecs(new Set())).toEqual(DEMO_GIFS);
  });
});

describe("ffmpegGifArgs", () => {
  it("builds a palettegen/paletteuse graph at the landing's frame rate and width", () => {
    const args = ffmpegGifArgs("/tmp/in.webm", "/out/review-board.gif");
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain(`fps=${GIF_FPS}`);
    expect(graph).toContain(`scale=${GIF_WIDTH}:-1`);
    expect(graph).toContain(`palettegen=max_colors=${GIF_COLORS}`);
    expect(graph).toContain("paletteuse");
    // The landing frame is 920 CSS px wide; a wider GIF is pure weight.
    expect(GIF_WIDTH).toBeLessThanOrEqual(1000);
    expect(args).toContain("/tmp/in.webm");
    expect(args.at(-1)).toBe("/out/review-board.gif");
    expect(args).toContain("-y");
  });
});

describe("failure messages", () => {
  it("tells the operator how to start the app it could not reach", () => {
    const message = appUnreachableMessage("http://127.0.0.1:3000", "ECONNREFUSED");
    expect(message).toContain("http://127.0.0.1:3000");
    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("pnpm dev");
    expect(message).toContain("--base-url");
  });

  it("names the install commands for the missing tools", () => {
    expect(missingPlaywrightMessage()).toContain("playwright install chromium");
    expect(missingFfmpegMessage()).toContain("brew install ffmpeg");
  });

  it("says which demo, which step and which target failed", () => {
    const spec = DEMO_GIFS[3];
    if (spec === undefined) throw new Error("expected a fourth demo");
    const step = spec.steps.find((candidate) => candidate.kind === "click");
    if (step === undefined) throw new Error("expected a click step");
    const message = stepFailureMessage(spec, step, "timeout 15000ms exceeded");
    expect(message).toContain(spec.name);
    expect(message).toContain(spec.route);
    expect(message).toContain("Request manual review");
    expect(message).toContain("timeout 15000ms exceeded");
  });
});
