import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export const EASE = [0.16, 1, 0.3, 1] as const;

/*
 * `data-reveal` is the hook the root document's <noscript> stylesheet uses to
 * force these elements visible. Motion serializes `initial` as an inline style
 * during SSR, so without it every revealed block ships at opacity 0 and the
 * page is blank when scripting is off.
 */

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      data-reveal
      initial={reduce ? false : { opacity: 0, y: 28 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
      viewport={{ once: true, amount: 0.3, margin: "0px 0px -8% 0px" }}
      whileInView={{ opacity: 1, y: 0 }}
    >
      {children}
    </motion.div>
  );
}

/** Mono eyebrow label: the section grammar of every Nomior page. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs tracking-[0.2em] text-gold uppercase">{children}</p>;
}

/**
 * Section headline: each line slides up out of a mask when scrolled into view.
 * The observer sits on the heading (never clipped); the clipped inner spans
 * animate through variant propagation, because an element hidden inside
 * `overflow-hidden` can never trigger its own `whileInView`.
 */
export function TitleLines({
  lines,
  className,
  as: Tag = "h2",
}: {
  lines: readonly string[];
  className?: string;
  as?: "h1" | "h2";
}) {
  const reduce = useReducedMotion();
  const Heading = Tag === "h1" ? motion.h1 : motion.h2;
  return (
    <Heading
      className={className}
      initial={reduce ? false : "hidden"}
      viewport={{ once: true, amount: 0.4 }}
      whileInView="visible"
    >
      {lines.map((line, index) => (
        <span className="block overflow-hidden pb-[0.08em]" key={line}>
          <motion.span
            className="block will-change-transform"
            data-reveal
            variants={{
              hidden: { y: "110%" },
              visible: { y: 0, transition: { duration: 0.9, delay: index * 0.12, ease: EASE } },
            }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </Heading>
  );
}
