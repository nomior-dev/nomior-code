import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import type { SVGProps } from "react";

/*
 * Nomior mark system, ported from nomior-website `src/components/marks.tsx`:
 * minimal geometry orbiting a single gold dot, 100x100 viewBox, 1.8 stroke in
 * `currentColor`, dot r=3.5 in gold. Company mark = three overlapping circles;
 * each product swaps the surrounding figures (Invest = ascending arcs, Music =
 * concentric rings, Estate = overlapping squares, Factory = overlapping
 * hexagons). Code is the fifth: two opposing chevrons with the dot held
 * between them.
 *
 * Unlike the website's version these render statically — the landing page must
 * read correctly with JavaScript disabled, and a `pathLength` draw-in leaves
 * an SVG blank when the animation never runs.
 */

type Shape =
  | {
      readonly el: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly opacity?: number;
    }
  | { readonly el: "path"; readonly d: string; readonly opacity?: number };

type MarkProps = SVGProps<SVGSVGElement> & { readonly size?: number };

const STROKE = { stroke: "currentColor", strokeWidth: 1.8, fill: "none" } as const;

function Mark({
  shapes,
  dot,
  size = 20,
  ...props
}: MarkProps & { readonly shapes: readonly Shape[]; readonly dot: { cx: number; cy: number } }) {
  return (
    <svg aria-hidden height={size} viewBox="0 0 100 100" width={size} {...props}>
      {shapes.map((shape) =>
        shape.el === "circle" ? (
          <circle
            cx={shape.cx}
            cy={shape.cy}
            key={`${shape.cx}-${shape.cy}-${shape.r}`}
            opacity={shape.opacity ?? 1}
            r={shape.r}
            {...STROKE}
          />
        ) : (
          <path d={shape.d} key={shape.d} opacity={shape.opacity ?? 1} {...STROKE} />
        ),
      )}
      <circle className="fill-gold" cx={dot.cx} cy={dot.cy} r={3.5} />
    </svg>
  );
}

/** Company mark: three overlapping circles. */
export function NomiorMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      dot={{ cx: 50, cy: 44 }}
      shapes={[
        { el: "circle", cx: 40, cy: 38, r: 24, opacity: 0.7 },
        { el: "circle", cx: 60, cy: 38, r: 20, opacity: 0.85 },
        { el: "circle", cx: 50, cy: 58, r: 22 },
      ]}
    />
  );
}

/** Nomior Code: opposing chevrons around the family's gold dot. */
export function CodeMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      dot={{ cx: 50, cy: 50 }}
      shapes={[
        { el: "path", d: "M 38 26 L 16 50 L 38 74" },
        { el: "path", d: "M 62 26 L 84 50 L 62 74", opacity: 0.7 },
      ]}
    />
  );
}

/**
 * Oversized ghost of the mark — the depth layer from the nomior-website
 * ecosystem cells: same geometry at 5% opacity, drifting against the scroll.
 * Without JavaScript it simply sits still, which is the correct fallback.
 */
export function CodeMarkGhost({ size = 620 }: { readonly size?: number }) {
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const y = useTransform(scrollY, [0, 900], [0, -140]);
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute top-1/2 -right-44 hidden -translate-y-1/2 md:block"
      style={reduce ? undefined : { y }}
    >
      <CodeMark className="text-cream opacity-[0.055]" size={size} />
    </motion.div>
  );
}
