import { Eyebrow, Reveal, TitleLines } from "./reveal";

export function Status() {
  return (
    <section className="scroll-mt-20 border-t border-line/60 py-28 md:py-40" id="status">
      <div className="mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <Reveal>
          <Eyebrow>Status</Eyebrow>
        </Reveal>
        <TitleLines
          className="mt-5 max-w-[14ch] text-3xl font-semibold tracking-tighter md:text-5xl"
          lines={["Not shipped yet."]}
        />
        <Reveal className="mt-6 max-w-[58ch]" delay={0.05}>
          <p className="leading-relaxed text-fog">
            Nomior Code is in development. This page describes the v1 scope and the constraints it
            is built under, not a product you can install today. The demo frames above stay empty
            until the recorder can capture them from a real build — a screenshot of something that
            does not run yet would be the exact kind of claim this product is meant to avoid.
          </p>
          <p className="mt-8 font-mono text-xs tracking-[0.14em] text-fog-dim uppercase">
            Want to hear when it runs
          </p>
          <a
            className="mt-3 inline-block text-xl font-medium text-gold underline decoration-gold/30 underline-offset-8 transition-colors duration-300 hover:decoration-gold md:text-2xl"
            href="mailto:info@nomior.com?subject=Nomior%20Code"
          >
            info@nomior.com
          </a>
        </Reveal>
      </div>
    </section>
  );
}
