import { Eyebrow, Reveal } from "./reveal";

interface LoopStep {
  readonly label: string;
  readonly title: string;
  readonly copy: string;
}

const STEPS: readonly LoopStep[] = [
  {
    label: "capsule",
    title: "Open a capsule",
    copy: "One unit per project: repo and worktrees, running stack, meetings, memory, sessions. Open it and everything the project knows is in the room.",
  },
  {
    label: "context",
    title: "Context, bounded",
    copy: "The broker answers questions with cited evidence on a hard token budget — never the whole vault. Every claim keeps its source and date.",
  },
  {
    label: "work",
    title: "Work in your client",
    copy: "Claude Code, Codex, Cursor, Grok, OpenCode — your accounts, signed in through each provider's own flow. Nomior never touches credentials.",
  },
  {
    label: "review",
    title: "Independent review",
    copy: "A second model reads the diff against your playbook and posts a deterministic verdict. The card crosses the board without leaving the app.",
  },
  {
    label: "memory",
    title: "Verified memory",
    copy: "Findings and decisions become memory candidates. You approve or reject each one — nothing is remembered behind your back.",
  },
];

export function Loop() {
  return (
    <section className="relative py-32 md:py-44" id="loop">
      <div className="mx-auto w-full max-w-[1100px] px-5 md:px-8">
        <Reveal>
          <Eyebrow>The core loop</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">
            Every session ends smarter than it started
          </h2>
        </Reveal>

        <ol className="relative mt-16 max-w-2xl list-none">
          {/* The gold thread: the loop's spine. */}
          <div
            aria-hidden
            className="absolute top-2 bottom-2 left-[5px] w-px bg-gradient-to-b from-gold/70 via-gold/30 to-gold/70"
          />
          {STEPS.map((step, index) => (
            <li className="relative pb-12 pl-10 last:pb-0" key={step.label}>
              <span
                aria-hidden
                className="absolute top-2 left-0 size-[11px] rounded-full border border-gold bg-ink"
              >
                <span className="absolute inset-[2px] rounded-full bg-gold/70" />
              </span>
              <Reveal delay={index * 0.05}>
                <p className="font-mono text-xs tracking-[0.2em] text-fog-dim uppercase">
                  {String(index + 1).padStart(2, "0")} · {step.label}
                </p>
                <h3 className="mt-2 text-xl font-medium tracking-tight md:text-2xl">
                  {step.title}
                </h3>
                <p className="mt-2 leading-relaxed text-fog">{step.copy}</p>
              </Reveal>
            </li>
          ))}
        </ol>

        <Reveal className="mt-14 max-w-2xl" delay={0.1}>
          <p className="border-l border-gold/50 pl-10 font-mono text-sm text-gold">
            …and the next session opens with everything this one learned.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
