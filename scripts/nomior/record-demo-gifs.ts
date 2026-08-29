#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - Host-side browser automation: plain Node subprocess, fs and fetch, no Effect runtime.

/**
 * Demo GIF recorder for the Nomior Code landing page.
 *
 * Demos are code (PLAN.md, M6): this script re-records the landing page's
 * workflow GIFs by driving the real, seeded app with Playwright, so a demo can
 * never drift from what the product does. It records the four flows PLAN.md
 * names — a cited context answer, the multi-account calendar week, the
 * scheduler picking an instance, and a review card crossing the board — and
 * writes them into `apps/nomior-landing/public/demos/`.
 *
 * It deliberately refuses to invent anything: no mocked frames, no stitched
 * screenshots. If the app is not running, Playwright is not installed, or a
 * step's target is missing from the UI, the run fails with the command that
 * fixes it. Usage: `docs/nomior/DEMO-GIFS.md`.
 *
 * The recorder follows `scripts/mobile-showcase.ts`, the repo's existing
 * drive-the-real-app capture pipeline: CLI filters, a fixed scene manifest,
 * and hard failure rather than a partial artifact set.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

/** Where the landing page's `DemoFigure` looks for the finished files. */
export const DEMO_OUTPUT_DIR = NodePath.join(REPO_ROOT, "apps/nomior-landing/public/demos");

export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/** 16:10 at 2x — the aspect the landing page reserves, downscaled for the GIF. */
export const CAPTURE_VIEWPORT = { width: 1280, height: 800 } as const;
/**
 * Output width and palette size, measured on a worst-case clip (a full-page
 * scroll, every pixel changing every frame): 1000/128 lands at ~950 KiB for
 * 2.5s where 1200/192 costs ~1.4 MiB for no visible gain at the 920px the
 * landing frame actually renders. Panel demos, which move one card at a time,
 * come out far smaller because `diff_mode=rectangle` only re-encodes the
 * changed region.
 */
export const GIF_WIDTH = 1000;
export const GIF_COLORS = 128;
export const GIF_FPS = 12;

/**
 * One scripted interaction. Targets are addressed the way a person reads the
 * screen — accessible role and name, visible text, form labels — so a demo
 * breaks loudly when the UI it documents actually changes, and does not break
 * when class names churn.
 */
export type DemoStep =
  | { readonly kind: "waitFor"; readonly text: string }
  | { readonly kind: "click"; readonly role: string; readonly name: string }
  | { readonly kind: "clickText"; readonly text: string }
  | { readonly kind: "type"; readonly label: string; readonly text: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "hold"; readonly ms: number };

export interface DemoGifSpec {
  /** Output file name under `apps/nomior-landing/public/demos/`. */
  readonly name: string;
  /** In-app route the scenario starts on. */
  readonly route: string;
  /** What the recording must show, end to end. */
  readonly scenario: string;
  /** Width : height. All landing demo boxes are 16:10 app-window frames. */
  readonly aspect: readonly [width: number, height: number];
  /** The interaction, in order. */
  readonly steps: readonly DemoStep[];
}

export const DEMO_GIFS: readonly DemoGifSpec[] = [
  {
    name: "cited-answer.gif",
    route: "/nomior/context",
    scenario:
      "Ask the context broker about last week's decision; it answers with cited snippets carrying source, date and excerpt.",
    aspect: [16, 10],
    steps: [
      { kind: "waitFor", text: "Search context" },
      { kind: "hold", ms: 700 },
      { kind: "type", label: "Search context", text: "scheduler" },
      { kind: "waitFor", text: "PLAN.md — instance scheduler" },
      { kind: "hold", ms: 2200 },
      { kind: "waitFor", text: "Memory candidates" },
      { kind: "hold", ms: 1200 },
    ],
  },
  {
    name: "calendar-week.gif",
    route: "/nomior/calendar",
    scenario:
      "A week across the connected Google accounts, colour-coded per account; a standup opens into its linked transcript.",
    aspect: [16, 10],
    steps: [
      { kind: "waitFor", text: "Recurring this week" },
      { kind: "hold", ms: 1200 },
      { kind: "click", role: "button", name: "Next week" },
      { kind: "hold", ms: 1200 },
      { kind: "click", role: "button", name: "Previous week" },
      { kind: "hold", ms: 800 },
      { kind: "clickText", text: "Daily standup" },
      { kind: "hold", ms: 2000 },
    ],
  },
  {
    name: "scheduler-switch.gif",
    route: "/nomior/instances",
    scenario:
      "The scheduler names the instance it picked and why; pinning one takes the automatic signals out of play.",
    aspect: [16, 10],
    steps: [
      { kind: "waitFor", text: "Scheduler" },
      { kind: "hold", ms: 1600 },
      { kind: "click", role: "button", name: "Pin" },
      { kind: "waitFor", text: "Pinned manually" },
      { kind: "hold", ms: 2000 },
      { kind: "click", role: "button", name: "Unpin" },
      { kind: "hold", ms: 1400 },
    ],
  },
  {
    name: "review-board.gif",
    route: "/nomior/review",
    scenario:
      "A review card crosses the board from Queue to a verdict, and is handed to a human without leaving the app.",
    aspect: [16, 10],
    steps: [
      { kind: "waitFor", text: "Waiting external" },
      { kind: "hold", ms: 1600 },
      { kind: "click", role: "button", name: "Request manual review" },
      { kind: "waitFor", text: "Manual review" },
      { kind: "hold", ms: 2200 },
    ],
  },
];

export class DemoRecorderError extends Error {
  override readonly name = "DemoRecorderError";
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested; no browser, no filesystem, no network)
 * ------------------------------------------------------------------ */

export interface CliOptions {
  readonly baseUrl: string;
  readonly only: ReadonlySet<string>;
  readonly outDir: string;
  readonly headed: boolean;
  readonly keepVideos: boolean;
}

export function parseCliOptions(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): CliOptions {
  let baseUrl = environment.NOMIOR_DEMO_BASE_URL ?? DEFAULT_BASE_URL;
  let outDir = DEMO_OUTPUT_DIR;
  let headed = false;
  let keepVideos = false;
  const only = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new DemoRecorderError(`${arg} needs a value.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--base-url":
        baseUrl = next();
        break;
      case "--out-dir":
        outDir = next();
        break;
      case "--only":
        for (const name of next().split(",")) {
          const trimmed = name.trim();
          if (trimmed !== "") only.add(trimmed.endsWith(".gif") ? trimmed : `${trimmed}.gif`);
        }
        break;
      case "--headed":
        headed = true;
        break;
      case "--keep-videos":
        keepVideos = true;
        break;
      default:
        throw new DemoRecorderError(
          `Unknown option ${arg}. Supported: --base-url, --out-dir, --only, --headed, --keep-videos.`,
        );
    }
  }

  const unknown = [...only].filter((name) => !DEMO_GIFS.some((spec) => spec.name === name));
  if (unknown.length > 0) {
    throw new DemoRecorderError(
      `--only names no such demo: ${unknown.join(", ")}. Known: ${DEMO_GIFS.map((spec) => spec.name).join(", ")}.`,
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), only, outDir, headed, keepVideos };
}

export function selectSpecs(only: ReadonlySet<string>): readonly DemoGifSpec[] {
  return only.size === 0 ? DEMO_GIFS : DEMO_GIFS.filter((spec) => only.has(spec.name));
}

/**
 * Two-pass palette in one graph: a generated palette beats the 216-colour
 * default badly on a dark UI, where banding in the near-black ground is the
 * first thing that reads as cheap.
 */
export function ffmpegGifArgs(input: string, output: string): readonly string[] {
  return [
    "-y",
    "-loglevel",
    "error",
    "-i",
    input,
    "-filter_complex",
    `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${GIF_COLORS}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    output,
  ];
}

export function appUnreachableMessage(baseUrl: string, reason: string): string {
  return [
    `Nomior Code is not answering at ${baseUrl} (${reason}).`,
    "",
    "The recorder drives the real app; it will not fake a frame. Start a seeded",
    "environment first, then re-run:",
    "",
    "  pnpm dev                       # web client + server",
    "  # sign in / pair once, then open http://127.0.0.1:3000/nomior/review",
    "  node scripts/nomior/record-demo-gifs.ts",
    "",
    `Point it elsewhere with --base-url <url> or NOMIOR_DEMO_BASE_URL.`,
  ].join("\n");
}

export function notPairedMessage(url: string): string {
  return [
    `The app redirected to ${url}: this session is not paired, so the /nomior panels are not reachable.`,
    "",
    "Pair the browser profile the recorder uses, or run against an environment",
    "that is already authenticated, then re-run. The recorder never records the",
    "pairing screen.",
  ].join("\n");
}

export function missingPlaywrightMessage(): string {
  return [
    "Playwright is not installed in this workspace.",
    "",
    "It is an on-demand dependency of the demo pipeline, not of the app, so it is",
    "loaded through a dynamic import and is absent from a normal install. Add it",
    "to the scripts package and download a browser:",
    "",
    "  pnpm --filter @t3tools/scripts add -D playwright",
    "  pnpm --filter @t3tools/scripts exec playwright install chromium",
  ].join("\n");
}

export function missingFfmpegMessage(): string {
  return [
    "ffmpeg is not on PATH; the recorder needs it to turn the captured video into a GIF.",
    "",
    "  macOS:  brew install ffmpeg",
    "  Debian: sudo apt-get install ffmpeg",
  ].join("\n");
}

export function stepFailureMessage(spec: DemoGifSpec, step: DemoStep, reason: string): string {
  const target =
    step.kind === "click"
      ? `${step.role} named "${step.name}"`
      : step.kind === "clickText" || step.kind === "waitFor"
        ? `text "${step.text}"`
        : step.kind === "type"
          ? `field labelled "${step.label}"`
          : step.kind;
  return [
    `${spec.name}: step "${step.kind}" could not find ${target} on ${spec.route}.`,
    "",
    `Scenario: ${spec.scenario}`,
    "",
    "Either the app is not seeded with the sample data this flow needs, or the UI",
    "changed and the step is now wrong. Fix the step in scripts/nomior/record-demo-gifs.ts",
    "rather than recording a different flow under the same file name.",
    "",
    `Playwright said: ${reason}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Playwright seam
 *
 * Typed structurally and imported through a runtime specifier so the repo
 * typechecks and installs without the dependency — the same dynamic-import
 * seam the Google connectors use for `googleapis`.
 * ------------------------------------------------------------------ */

interface DemoLocator {
  first(): DemoLocator;
  click(options?: { timeout?: number }): Promise<void>;
  pressSequentially(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
}

interface DemoVideo {
  saveAs(path: string): Promise<void>;
  delete(): Promise<void>;
}

interface DemoPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  url(): string;
  getByRole(role: string, options?: { name?: string }): DemoLocator;
  getByLabel(name: string, options?: { exact?: boolean }): DemoLocator;
  getByText(text: string, options?: { exact?: boolean }): DemoLocator;
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  video(): DemoVideo | null;
  close(): Promise<void>;
}

interface DemoContext {
  newPage(): Promise<DemoPage>;
  close(): Promise<void>;
}

interface DemoBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    colorScheme: "dark";
    reducedMotion: "no-preference";
    recordVideo: { dir: string; size: { width: number; height: number } };
  }): Promise<DemoContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  readonly chromium: { launch(options: { headless: boolean }): Promise<DemoBrowser> };
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  for (const specifier of ["playwright", "playwright-core"]) {
    try {
      return (await import(/* @vite-ignore */ specifier)) as PlaywrightModule;
    } catch {
      continue;
    }
  }
  throw new DemoRecorderError(missingPlaywrightMessage());
}

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

async function assertAppRunning(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (cause) {
    throw new DemoRecorderError(
      appUnreachableMessage(baseUrl, cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited ${code}${stderr === "" ? "" : `: ${stderr.trim()}`}`));
    });
  });
}

async function assertFfmpeg(): Promise<void> {
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-version"]);
  } catch {
    throw new DemoRecorderError(missingFfmpegMessage());
  }
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

const STEP_TIMEOUT_MS = 15_000;

function locatorFor(page: DemoPage, step: DemoStep): DemoLocator | null {
  switch (step.kind) {
    case "waitFor":
    case "clickText":
      return page.getByText(step.text).first();
    case "click":
      return page.getByRole(step.role, { name: step.name }).first();
    case "type":
      return page.getByLabel(step.label).first();
    default:
      return null;
  }
}

async function runStep(page: DemoPage, spec: DemoGifSpec, step: DemoStep): Promise<void> {
  if (step.kind === "hold") {
    await page.waitForTimeout(step.ms);
    return;
  }
  if (step.kind === "press") {
    await page.keyboard.press(step.key);
    return;
  }
  const locator = locatorFor(page, step);
  if (locator === null) return;
  try {
    await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
    if (step.kind === "click" || step.kind === "clickText") {
      await locator.click({ timeout: STEP_TIMEOUT_MS });
    } else if (step.kind === "type") {
      await locator.click({ timeout: STEP_TIMEOUT_MS });
      // Per-character so the recording shows a query being typed, not pasted.
      await locator.pressSequentially(step.text, { delay: 90, timeout: STEP_TIMEOUT_MS });
    }
  } catch (cause) {
    throw new DemoRecorderError(
      stepFailureMessage(spec, step, cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

async function recordSpec(
  browser: DemoBrowser,
  spec: DemoGifSpec,
  options: CliOptions,
  videoDir: string,
): Promise<string> {
  const context = await browser.newContext({
    viewport: { ...CAPTURE_VIEWPORT },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    recordVideo: { dir: videoDir, size: { ...CAPTURE_VIEWPORT } },
  });
  const page = await context.newPage();
  const webmPath = NodePath.join(videoDir, `${spec.name.replace(/\.gif$/, "")}.webm`);
  try {
    await page.goto(`${options.baseUrl}${spec.route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_200);
    if (page.url().includes("/pair")) {
      throw new DemoRecorderError(notPairedMessage(page.url()));
    }
    for (const step of spec.steps) {
      await runStep(page, spec, step);
    }
    await page.waitForTimeout(600);
  } finally {
    // The video file is only finalized on context close, so grab the handle
    // first and save after — this runs on the failure path too, which keeps a
    // broken run's footage around under --keep-videos for diagnosis.
    const video = page.video();
    await context.close();
    if (video !== null) await video.saveAs(webmPath);
  }

  const gifPath = NodePath.join(options.outDir, spec.name);
  await NodeFSP.mkdir(options.outDir, { recursive: true });
  await run("ffmpeg", ffmpegGifArgs(webmPath, gifPath));
  if (!options.keepVideos) await NodeFSP.rm(webmPath, { force: true });
  return gifPath;
}

async function main(): Promise<void> {
  const options = parseCliOptions(NodeProcess.argv.slice(2), NodeProcess.env);
  const specs = selectSpecs(options.only);

  await assertFfmpeg();
  await assertAppRunning(options.baseUrl);
  const playwright = await loadPlaywright();

  const videoDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nomior-demo-"));
  const browser = await playwright.chromium.launch({ headless: !options.headed });
  const written: string[] = [];
  try {
    for (const spec of specs) {
      NodeProcess.stdout.write(`recording ${spec.name} … `);
      written.push(await recordSpec(browser, spec, options, videoDir));
      NodeProcess.stdout.write("ok\n");
    }
  } finally {
    await browser.close();
    if (!options.keepVideos) await NodeFSP.rm(videoDir, { recursive: true, force: true });
  }

  NodeProcess.stdout.write(
    `\n${written.length} demo${written.length === 1 ? "" : "s"} written to ${options.outDir}\n` +
      "Flip `available` on the matching DemoFigure in apps/nomior-landing/src/components/features.tsx.\n",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message =
      error instanceof DemoRecorderError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    NodeProcess.stderr.write(`\nrecord-demo-gifs failed.\n\n${message}\n`);
    NodeProcess.exit(1);
  });
}
