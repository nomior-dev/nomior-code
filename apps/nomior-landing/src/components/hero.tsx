import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { CodeMarkGhost } from "./marks";
import { EASE, Eyebrow } from "./reveal";

/** Facts, not adjectives — the three constraints the whole product is built on. */
const FACTS = [
  { term: "Where it runs", detail: "Your machine. Local SQLite, no account required." },
  { term: "Whose AI", detail: "The provider subscriptions you already pay for." },
  { term: "Credentials", detail: "Never read, stored or proxied. Not once." },
] as const;

function Line({ children, delay }: { children: ReactNode; delay: number }) {
  const reduce = useReducedMotion();
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <motion.span
        animate={{ y: 0 }}
        className="block will-change-transform"
        data-reveal
        initial={reduce ? false : { y: "110%" }}
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
    <section
      className="relative flex min-h-[92dvh] items-center overflow-x-clip pt-24 pb-20"
      id="top"
    >
      <CodeMarkGhost />
      <div className="relative mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <motion.div
          animate={{ opacity: 1 }}
          data-reveal
          initial={reduce ? false : { opacity: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <Eyebrow>Nomior Code · local-first · in development</Eyebrow>
        </motion.div>

        <h1 className="mt-7 text-[clamp(2.05rem,7.2vw,5.2rem)] leading-[1.03] font-semibold tracking-tighter">
          <Line delay={0.1}>Your project&rsquo;s memory,</Line>
          <Line delay={0.24}>
            in the app where you code
            <span
              aria-hidden
              className="ml-[0.08em] inline-block size-[0.13em] rounded-full bg-gold align-baseline"
            />
          </Line>
        </h1>

        <motion.p
          animate={{ opacity: 1, y: 0 }}
          className="mt-9 max-w-[56ch] text-base leading-relaxed text-fog md:text-lg"
          data-reveal
          initial={reduce ? false : { opacity: 0, y: 20 }}
          transition={{ duration: 0.9, delay: 0.55, ease: EASE }}
        >
          Capsules, meetings, bounded context, verified memory and independent review, in one
          local-first app. Your coding agents get cited context on a hard token budget, and every
          finding you approve makes the next session start smarter.
        </motion.p>

        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4"
          data-reveal
          initial={reduce ? false : { opacity: 0, y: 20 }}
          transition={{ duration: 0.9, delay: 0.68, ease: EASE }}
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
          <p className="font-mono text-xs text-fog-dim">
            Free while it runs on your machine
            <span aria-hidden className="mx-2 text-line">
              /
            </span>
            you pay only for what runs on ours
          </p>
        </motion.div>

        <motion.dl
          animate={{ opacity: 1 }}
          className="mt-16 grid max-w-4xl grid-cols-1 border-t border-line sm:grid-cols-3"
          data-reveal
          initial={reduce ? false : { opacity: 0 }}
          transition={{ duration: 0.9, delay: 0.85, ease: EASE }}
        >
          {FACTS.map((fact) => (
            <div className="border-b border-line py-5 sm:border-b-0 sm:pr-8" key={fact.term}>
              <dt className="font-mono text-[11px] tracking-[0.18em] text-fog-dim uppercase">
                {fact.term}
              </dt>
              <dd className="mt-2 text-sm leading-relaxed text-fog">{fact.detail}</dd>
            </div>
          ))}
        </motion.dl>
      </div>
      <div aria-hidden className="absolute top-24 h-px w-px" id="top-sentinel" />
    </section>
  );
}
