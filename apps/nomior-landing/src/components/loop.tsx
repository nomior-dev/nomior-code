import { Eyebrow, Reveal, TitleLines } from "./reveal";

interface LoopStep {
  readonly label: string;
  readonly title: string;
  readonly copy: string;
}

const STEPS: readonly LoopStep[] = [
  {
    label: "capsule",
    title: "Open a capsule",
    copy: "One unit per project: repo and worktrees, the runtime that starts it, its meetings, its memory, its sessions. Open it and everything the project knows is in the room.",
  },
  {
    label: "context",
    title: "Context, bounded",
    copy: "The broker answers with cited evidence on a hard token budget — never the whole vault. Every snippet keeps its source, its date and its excerpt, and a query in one project never surfaces another's.",
  },
  {
    label: "work",
    title: "Work in your own client",
    copy: "Claude Code, Codex, Cursor, Grok, OpenCode. You sign in to the accounts you already have, through each provider's own flow, into that provider's own local profile. Nomior Code never sees a credential.",
  },
  {
    label: "review",
    title: "Independent review",
    copy: "A second model reads the diff against your repo's playbook. The verdict gate is deterministic code, not a model's opinion, and nothing is posted to your forge until you approve it.",
  },
  {
    label: "memory",
    title: "Verified memory",
    copy: "Findings and decisions become memory candidates. You approve or reject each one, and only then is it written — into the store, and into the CLAUDE.md or AGENTS.md conventions your tools already read.",
  },
];

export function Loop() {
  return (
    <section className="scroll-mt-20 py-28 md:py-40" id="loop">
      <div className="mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <Reveal>
          <Eyebrow>The core loop</Eyebrow>
        </Reveal>
        <TitleLines
          className="mt-5 max-w-[20ch] text-3xl font-semibold tracking-tighter md:text-5xl"
          lines={["Every session ends", "smarter than it started"]}
        />

        <ol className="relative mt-16 max-w-[62ch] list-none">
          {/* The gold thread: the loop's spine, closing back on itself. */}
          <div
            aria-hidden
            className="absolute top-2 bottom-2 left-[5px] w-px bg-gradient-to-b from-gold/70 via-gold/25 to-gold/70"
          />
          {STEPS.map((step, index) => (
            <li className="relative pb-11 pl-10 last:pb-0" key={step.label}>
              <span
                aria-hidden
                className="absolute top-[7px] left-0 size-[11px] rounded-full border border-gold bg-ink"
              >
                <span className="absolute inset-[2.5px] rounded-full bg-gold/70" />
              </span>
              <Reveal delay={index * 0.04}>
                <p className="font-mono text-[11px] tracking-[0.2em] text-fog-dim uppercase">
                  {String(index + 1).padStart(2, "0")}
                  <span aria-hidden className="mx-2 text-line">
                    /
                  </span>
                  {step.label}
                </p>
                <h3 className="mt-2 text-xl font-medium tracking-tight md:text-2xl">
                  {step.title}
                </h3>
                <p className="mt-2.5 leading-relaxed text-fog">{step.copy}</p>
              </Reveal>
            </li>
          ))}
        </ol>

        <Reveal className="mt-12 max-w-[62ch]" delay={0.1}>
          <p className="border-l border-gold/50 py-1 pl-10 font-mono text-sm leading-relaxed text-gold">
            …and the next capsule you open starts with everything this session learned.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
