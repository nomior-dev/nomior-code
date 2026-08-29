// @effect-diagnostics nodeBuiltinImport:off - Asserts output paths the recorder builds with the same Node primitive.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  appUnreachableMessage,
  type DemoBrowser,
  DEMO_GIFS,
  type DemoContextOptions,
  type DemoLocator,
  type DemoPage,
  DemoRecorderError,
  type DemoStorageState,
  ffmpegGifArgs,
  GIF_COLORS,
  GIF_FPS,
  GIF_WIDTH,
  missingFfmpegMessage,
  missingPlaywrightMessage,
  notPairedMessage,
  parseCliOptions,
  recordDemos,
  selectSpecs,
  stepFailureMessage,
} from "./record-demo-gifs.ts";

const BASE_URL = "http://127.0.0.1:3000";
const PAIR_URL = `${BASE_URL}/pair#token=one-time`;
const PAIRED_STATE: DemoStorageState = { cookies: ["session"], origins: [] };

/**
 * A browser whose pages simply land on the URL they are told to open, except
 * that a pair URL hands over a session and bounces off `/pair` — the one app
 * behaviour the recorder's pairing pass depends on.
 */
function fakeBrowser(config: { readonly staysOnPair?: boolean } = {}): {
  readonly browser: DemoBrowser;
  readonly contexts: readonly DemoContextOptions[];
  readonly visited: readonly string[];
} {
  const contexts: DemoContextOptions[] = [];
  const visited: string[] = [];
  const locator: DemoLocator = {
    first: () => locator,
    click: () => Promise.resolve(),
    pressSequentially: () => Promise.resolve(),
    waitFor: () => Promise.resolve(),
    scrollIntoViewIfNeeded: () => Promise.resolve(),
  };
  const browser: DemoBrowser = {
    newContext: (options) => {
      contexts.push(options);
      let current = "about:blank";
      const page: DemoPage = {
        goto: (url) => {
          visited.push(url);
          current =
            url.includes("/pair") && config.staysOnPair !== true ? `${BASE_URL}/nomior` : url;
          return Promise.resolve(undefined);
        },
        url: () => current,
        waitForURL: (predicate) =>
          predicate(new URL(current)) ? Promise.resolve() : Promise.reject(new Error("timeout")),
        getByRole: () => locator,
        getByLabel: () => locator,
        getByText: () => locator,
        keyboard: { press: () => Promise.resolve() },
        waitForTimeout: () => Promise.resolve(),
        video: () => null,
        close: () => Promise.resolve(),
      };
      return Promise.resolve({
        newPage: () => Promise.resolve(page),
        storageState: () => Promise.resolve(PAIRED_STATE),
        close: () => Promise.resolve(),
      });
    },
    close: () => Promise.resolve(),
  };
  return { browser, contexts, visited };
}

async function failureOf(run: () => Promise<unknown>): Promise<DemoRecorderError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DemoRecorderError) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

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

  it("has no pairing URL until it is given one", () => {
    expect(parseCliOptions([], {}).pairUrl).toBeUndefined();
    expect(parseCliOptions([], { NOMIOR_DEMO_PAIR_URL: "  " }).pairUrl).toBeUndefined();
  });

  it("takes the pairing URL from a flag or the environment, flag first", () => {
    expect(parseCliOptions(["--pair-url", PAIR_URL], {}).pairUrl).toBe(PAIR_URL);
    expect(parseCliOptions([], { NOMIOR_DEMO_PAIR_URL: PAIR_URL }).pairUrl).toBe(PAIR_URL);
    expect(
      parseCliOptions(["--pair-url", PAIR_URL], {
        NOMIOR_DEMO_PAIR_URL: `${BASE_URL}/pair#token=stale`,
      }).pairUrl,
    ).toBe(PAIR_URL);
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

  it("rejects unknown flags, naming every flag that does exist", () => {
    expect(() => parseCliOptions(["--fast"], {})).toThrow(/Unknown option --fast/);
    let message = "";
    try {
      parseCliOptions(["--fast"], {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    for (const flag of [
      "--base-url",
      "--pair-url",
      "--out-dir",
      "--only",
      "--headed",
      "--keep-videos",
    ]) {
      expect(message).toContain(flag);
    }
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

  it("points an unpaired session at the flag that fixes it", () => {
    const message = notPairedMessage(`${BASE_URL}/pair`);
    expect(message).toContain("--pair-url");
    expect(message).toContain("node apps/server/src/bin.ts pair");
    expect(message).toContain("NOMIOR_DEMO_PAIR_URL");
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

describe("recordDemos", () => {
  const silent = { encode: () => Promise.resolve(), report: () => {} } as const;

  it("spends the pairing token once, however many demos are recorded", async () => {
    for (const count of [1, DEMO_GIFS.length]) {
      const { browser, contexts, visited } = fakeBrowser();
      const options = parseCliOptions(["--pair-url", PAIR_URL, "--out-dir", "/out"], {});
      const written = await recordDemos({
        browser,
        options,
        specs: DEMO_GIFS.slice(0, count),
        videoDir: "/videos",
        ...silent,
      });
      expect(written).toEqual(
        DEMO_GIFS.slice(0, count).map((spec) => NodePath.join("/out", spec.name)),
      );
      expect(visited.filter((url) => url === PAIR_URL)).toEqual([PAIR_URL]);
      // One pairing context, then one per demo.
      expect(contexts).toHaveLength(count + 1);
    }
  });

  it("replays the paired session into every recording context", async () => {
    const { browser, contexts } = fakeBrowser();
    const options = parseCliOptions(["--pair-url", PAIR_URL], {});
    await recordDemos({
      browser,
      options,
      specs: DEMO_GIFS,
      videoDir: "/videos",
      ...silent,
    });
    const [pairing, ...recordings] = contexts;
    // The pairing pass is not a take: no session to replay yet, nothing to film.
    expect(pairing?.storageState).toBeUndefined();
    expect(pairing?.recordVideo).toBeUndefined();
    expect(recordings).toHaveLength(DEMO_GIFS.length);
    for (const recording of recordings) {
      expect(recording.storageState).toBe(PAIRED_STATE);
      expect(recording.recordVideo?.dir).toBe("/videos");
    }
  });

  it("records with no session when no pairing URL is given", async () => {
    const { browser, contexts, visited } = fakeBrowser();
    const options = parseCliOptions(["--only", "review-board"], {});
    await recordDemos({
      browser,
      options,
      specs: selectSpecs(options.only),
      videoDir: "/videos",
      ...silent,
    });
    expect(visited).toEqual([`${BASE_URL}/nomior/review`]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.storageState).toBeUndefined();
  });

  it("blames a consumed token when the pair URL never leaves /pair", async () => {
    const { browser, contexts } = fakeBrowser({ staysOnPair: true });
    const options = parseCliOptions(["--pair-url", PAIR_URL], {});
    const error = await failureOf(() =>
      recordDemos({ browser, options, specs: DEMO_GIFS, videoDir: "/videos", ...silent }),
    );
    expect(error.message).toContain("single-use");
    expect(error.message).toContain("already consumed");
    expect(error.message).toContain("node apps/server/src/bin.ts pair");
    // Nothing was filmed: the pairing context is the only one that was opened.
    expect(contexts).toHaveLength(1);
  });

  it("refuses a pairing URL minted for another origin", async () => {
    const { browser, contexts } = fakeBrowser();
    const options = parseCliOptions(
      ["--pair-url", "http://192.168.1.5:3000/pair#token=one-time"],
      {},
    );
    const error = await failureOf(() =>
      recordDemos({ browser, options, specs: DEMO_GIFS, videoDir: "/videos", ...silent }),
    );
    expect(error.message).toContain("http://192.168.1.5:3000");
    expect(error.message).toContain(BASE_URL);
    expect(contexts).toHaveLength(0);
  });
});
