# Demo GIFs — recorded from the real app

The landing page's four workflow demos are **code, not assets**. They are
re-recorded from a running, seeded Nomior Code by
`scripts/nomior/record-demo-gifs.ts` (PLAN.md, M6), so a demo cannot drift from
what the product does. Nothing in the pipeline mocks a frame: if the app is not
up, or a step's target is missing from the UI, the run fails and prints the
command that fixes it.

## The four demos

| File                   | Route               | What it must show                                                                 |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `cited-answer.gif`     | `/nomior/context`   | A context query answered with cited snippets — source, date, excerpt              |
| `calendar-week.gif`    | `/nomior/calendar`  | A week across the connected Google accounts; a standup opens its transcript       |
| `scheduler-switch.gif` | `/nomior/instances` | The scheduler naming the instance it picked and why; pinning takes it out of play |
| `review-board.gif`     | `/nomior/review`    | A review card crossing the board and being handed to a human                      |

The manifest in `scripts/nomior/record-demo-gifs.ts` (`DEMO_GIFS`) is the single
source of truth for names, routes and steps. The landing page's `DemoFigure`
boxes use the same names and the same 16:10 frame, so a finished recording drops
in without shifting the layout.

## Prerequisites

1. **ffmpeg on PATH** — `brew install ffmpeg` / `apt-get install ffmpeg`.
2. **Playwright + Chromium.** Deliberately not a normal workspace dependency:
   the recorder loads it through a dynamic import so a plain `pnpm install`
   stays lean. Install it when you need to record:

   ```sh
   pnpm --filter @t3tools/scripts add -D playwright
   pnpm --filter @t3tools/scripts exec playwright install chromium
   ```

3. **A running, authenticated app** with the Nomior panels reachable. The
   panels fall back to sample fixtures (`apps/web/src/nomior/fixtures.ts`) when
   the RPC port is absent, which is exactly what the demos record — the "Sample
   data" badge is visible on purpose.

   ```sh
   pnpm dev                 # server + web client on http://127.0.0.1:3000
   # pair the browser once, then confirm /nomior/review renders
   ```

   The `/nomior` route redirects to `/pair` when the session is not
   authenticated. The recorder detects that redirect and stops rather than
   filming the pairing screen.

## Recording

```sh
node scripts/nomior/record-demo-gifs.ts                      # all four
node scripts/nomior/record-demo-gifs.ts --only review-board  # one
node scripts/nomior/record-demo-gifs.ts --headed             # watch it drive
node scripts/nomior/record-demo-gifs.ts --keep-videos        # keep the .webm
```

| Flag / env             | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `--base-url <url>`     | Where the app is (default `http://127.0.0.1:3000`)            |
| `NOMIOR_DEMO_BASE_URL` | Same, from the environment; the flag wins                     |
| `--only a,b`           | Record a subset; `.gif` optional; an unknown name is an error |
| `--out-dir <dir>`      | Override `apps/nomior-landing/public/demos`                   |
| `--headed`             | Run Chromium headed                                           |
| `--keep-videos`        | Keep the intermediate `.webm`, including from a failed run    |

Capture is 1280×800 at `deviceScaleFactor: 2` (16:10, matching the landing
frame), transcoded with a generated palette — `fps=12`, `scale=1000`,
`max_colors=128`, `palettegen`/`paletteuse` — because the default 216-colour GIF
palette bands badly on a dark UI. Measured on a worst-case clip (a full-page
scroll, every pixel changing): 1000/128 lands at ~950 KiB for 2.5s where
1200/192 costs ~1.4 MiB and shows nothing more at the 920 CSS px the landing
frame renders. Panel demos come out far smaller because `diff_mode=rectangle`
re-encodes only the region that moved. Keep a finished demo under ~2 MB; if one
is heavier, shorten the scenario rather than raising the settings.

## After recording

The landing frames render as reserved placeholders until they are told the file
exists. For each new recording, set `available` on its `DemoFigure` in
`apps/nomior-landing/src/components/features.tsx`, then rebuild:

```sh
pnpm build:landing
```

## When a step fails

A failure names the demo, the step, the target it could not find and the route.
Two causes, one rule:

- **The app is not seeded** with the data that flow needs → fix the environment.
- **The UI changed** → fix the step in `DEMO_GIFS`, so the demo keeps documenting
  the real flow. Never repoint a step at a different flow to keep the same file
  name green; the file name is a promise about what the GIF shows.

`scripts/nomior/record-demo-gifs.test.ts` covers the manifest shape, the CLI
parsing and the failure messages, and runs in the normal suite
(`vp run --filter @t3tools/scripts test`) with no browser.
