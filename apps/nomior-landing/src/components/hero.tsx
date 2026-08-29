import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { EASE, Eyebrow } from "./reveal";

function Line({
  children,
  delay,
  className,
}: {
  children: ReactNode;
  delay: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <span className={`block overflow-hidden pb-[0.08em] ${className ?? ""}`}>
      <motion.span
        className="block will-change-transform"
        initial={reduce ? false : { y: "110%" }}
        animate={{ y: 0 }}
        transition={{ duration: 1.1, delay, ease: EASE }}
      >
        {children}
      </motion.span>
    </span>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  return (
    <section className="relative flex min-h-[92dvh] items-center" id="top">
      <div className="mx-auto w-full max-w-[1100px] px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <Eyebrow>Nomior Code · local-first</Eyebrow>
        </motion.div>
        <h1 className="mt-6 text-[clamp(2.6rem,7vw,5.5rem)] leading-[1.02] font-semibold tracking-tighter">
          <Line delay={0.1}>Your project&rsquo;s memory,</Line>
          <Line delay={0.24}>
            in the app where you code
            <span
              aria-hidden
              className="ml-[0.08em] inline-block size-[0.14em] rounded-full bg-gold"
            />
          </Line>
        </h1>
        <motion.p
          initial={reduce ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.55, ease: EASE }}
          className="mt-10 max-w-xl text-base leading-relaxed text-fog md:text-lg"
        >
          Nomior Code brings your project&rsquo;s context, meetings, memory and code review into one
          local-first app. Your coding agents get bounded, cited context; every finding you approve
          makes the next session smarter. On your machine, on your own subscriptions.
        </motion.p>
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.68, ease: EASE }}
          className="mt-10 flex flex-wrap items-center gap-5"
        >
          <a
            className="group inline-flex h-12 items-center gap-3 rounded-full bg-cream px-6 text-[15px] font-medium whitespace-nowrap text-ink-deep transition-transform duration-300 active:scale-[0.98]"
            href="#loop"
          >
            See the core loop
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full bg-gold transition-transform duration-300 group-hover:translate-y-0.5"
            />
          </a>
          <p className="font-mono text-xs text-fog-dim">Free while it runs on your machine.</p>
        </motion.div>
      </div>
    </section>
  );
}
