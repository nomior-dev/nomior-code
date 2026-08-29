/**
 * Placeholder for a Playwright-recorded demo GIF.
 *
 * Demo GIFs are code: `scripts/nomior/record-demo-gifs.ts` re-records each one
 * from the real app on release, so the boxes here carry the exact aspect ratio
 * and file name the recorder will produce. Swap `src` in when the recording
 * exists; the figure keeps its layout either way.
 */
export function DemoFigure({
  name,
  caption,
  src,
}: {
  /** File name the recorder emits, e.g. `review-board.gif`. */
  name: string;
  caption: string;
  src?: string;
}) {
  return (
    <figure className="mt-10">
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-[var(--radius-brand)] border border-line bg-surface">
        {src ? (
          <img alt={caption} className="size-full object-cover" src={src} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span
              aria-hidden
              className="size-2 rounded-full bg-gold motion-safe:animate-dot-pulse"
            />
            <p className="font-mono text-xs text-fog-dim">{name}</p>
            <p className="font-mono text-[11px] text-fog-dim/70">
              recorded from the real app on each release
            </p>
          </div>
        )}
      </div>
      <figcaption className="mt-3 font-mono text-xs leading-relaxed text-fog">{caption}</figcaption>
    </figure>
  );
}
