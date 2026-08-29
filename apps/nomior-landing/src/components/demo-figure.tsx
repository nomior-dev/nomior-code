/**
 * Frame for a Playwright-recorded demo GIF.
 *
 * Demos are code (PLAN.md, M6): `scripts/nomior/record-demo-gifs.ts` re-records
 * each one from the real app, so the frames here carry the exact file name and
 * aspect ratio the recorder emits. The box reserves its full height whether or
 * not the file exists, so a landing recording drops in without moving a pixel
 * of the page below it — and until then it reads as a reserved frame, never as
 * a screenshot of something that does not run yet.
 */

/** Every landing demo is a 16:10 app-window frame; the recorder asserts this. */
const DEMO_ASPECT = { width: 1600, height: 1000 } as const;

export function DemoFigure({
  name,
  caption,
  index,
  available = false,
}: {
  /** File name the recorder emits, e.g. `review-board.gif`. */
  name: string;
  caption: string;
  /** Ordinal shown in the frame's mono chrome. */
  index: string;
  /** Flip on once `public/demos/<name>` is committed. */
  available?: boolean;
}) {
  return (
    <figure className="mt-12 max-w-[920px]">
      <div className="flex items-baseline gap-3 border-b border-line pb-2 font-mono text-[11px] tracking-[0.16em] text-fog-dim uppercase">
        <span className="shrink-0 whitespace-nowrap">{index}</span>
        <span aria-hidden className="shrink-0 text-line">
          /
        </span>
        <span className="truncate">{name}</span>
        <span className="ms-auto hidden shrink-0 normal-case sm:inline">
          {available ? "recorded from the app" : "recording pending"}
        </span>
      </div>
      <div
        className="relative w-full overflow-hidden rounded-b-[var(--radius-brand)] border border-t-0 border-line bg-surface"
        style={{ aspectRatio: `${DEMO_ASPECT.width} / ${DEMO_ASPECT.height}` }}
      >
        {available ? (
          <img
            alt={caption}
            className="size-full object-cover"
            height={DEMO_ASPECT.height}
            loading="lazy"
            src={`/demos/${name}`}
            width={DEMO_ASPECT.width}
          />
        ) : (
          <>
            {/* Reserved-frame mark: the print convention for a plate held open. */}
            <svg
              aria-hidden
              className="absolute inset-0 size-full text-line"
              preserveAspectRatio="none"
              viewBox="0 0 100 100"
            >
              <path
                d="M0 0 L100 100 M100 0 L0 100"
                opacity="0.6"
                stroke="currentColor"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <span
                aria-hidden
                className="size-2 rounded-full bg-gold motion-safe:animate-dot-pulse"
              />
              <p className="max-w-[44ch] bg-surface px-3 font-mono text-[11px] leading-relaxed text-fog-dim">
                Re-recorded from the real app on every release, never mocked up.
              </p>
            </div>
          </>
        )}
      </div>
      <figcaption className="mt-3 max-w-[62ch] font-mono text-xs leading-relaxed text-fog">
        {caption}
      </figcaption>
    </figure>
  );
}
