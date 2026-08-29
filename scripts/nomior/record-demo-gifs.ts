/**
 * Demo GIF recorder for the Nomior Code landing page — stub.
 *
 * Demos are code (PLAN.md, M6): on each release this script re-records the
 * landing page's workflow GIFs from the real app, so they never go stale and
 * never lie. The recording pipeline, when implemented, will:
 *
 *   1. Launch a disposable dev environment (worktree-local `.t3` home) with a
 *      seeded fixture database, the way the `test-t3-app` flow does.
 *   2. Drive the web client with Playwright (`@playwright/test` as a
 *      devDependency of this package; not installed while this is a stub):
 *      one `page` per manifest entry, viewport sized to the entry's aspect
 *      ratio at 2x for crisp downscaling.
 *   3. Record each scenario with Playwright's built-in video capture, then
 *      transcode webm → gif with ffmpeg (palettegen/paletteuse, 12 fps,
 *      lossy=80) into `apps/nomior-landing/public/demos/<name>`.
 *   4. Fail the release job when a scenario cannot complete — a missing demo
 *      must block, not silently ship a stale GIF.
 *
 * The manifest below is the single source of truth: the landing page's
 * `DemoFigure` boxes use these exact names and aspect ratio, so recordings
 * drop into place without touching the site.
 */
import * as NodeProcess from "node:process";

export interface DemoGifSpec {
  /** Output file name under `apps/nomior-landing/public/demos/`. */
  readonly name: string;
  /** In-app route the scenario starts on. */
  readonly route: string;
  /** What the recording must show, end to end. */
  readonly scenario: string;
  /** Width : height. All landing demo boxes are 16:10 app-window frames. */
  readonly aspect: readonly [width: number, height: number];
}

export const DEMO_GIFS: readonly DemoGifSpec[] = [
  {
    name: "cited-answer.gif",
    route: "/",
    scenario:
      "Ask a fork-started session about last week's decision; the context broker answers with cited snippets.",
    aspect: [16, 10],
  },
  {
    name: "calendar-week.gif",
    route: "/nomior/calendar",
    scenario:
      "Week view over three color-coded Google accounts; open a standup's linked transcript.",
    aspect: [16, 10],
  },
  {
    name: "scheduler-switch.gif",
    route: "/nomior/instances",
    scenario:
      "One instance throttles; a new thread routes to the other with the scheduler's reason visible.",
    aspect: [16, 10],
  },
  {
    name: "review-board.gif",
    route: "/nomior/review",
    scenario: "A review card crosses the board from Queue to a verdict without leaving the app.",
    aspect: [16, 10],
  },
];

if (import.meta.main) {
  NodeProcess.stderr.write(
    "record-demo-gifs: recording is not implemented yet. This stub documents the pipeline and " +
      `carries the manifest for ${DEMO_GIFS.length} GIFs (see DEMO_GIFS).\n`,
  );
  NodeProcess.exit(1);
}
