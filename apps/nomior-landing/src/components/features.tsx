import { DemoFigure } from "./demo-figure";
import { Eyebrow, Reveal, TitleLines } from "./reveal";

interface Feature {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: readonly string[];
  readonly copy: readonly string[];
  readonly demo?: { readonly name: string; readonly caption: string };
}

const FEATURES: readonly Feature[] = [
  {
    id: "context",
    eyebrow: "Context broker",
    title: ["Ask the project,", "get evidence"],
    copy: [
      "Meetings, calendar events, the mail threads you opted in, past decisions and past reviews sit behind one search. Answers come back as ranked snippets with a source, a date and the excerpt they came from — on a hard token budget, so your agent's window stays lean.",
      "The same broker is an MCP toolkit any client can call: four tools, one of them loaded and three deferred until used. Search never returns a raw transcript body; it returns ids you can drill into.",
    ],
    demo: {
      name: "cited-answer.gif",
      caption:
        "A session started from the app asks about last week's decision; the broker answers with two cited snippets and their dates.",
    },
  },
  {
    id: "meetings",
    eyebrow: "Meetings",
    title: ["Bring your own", "recorder"],
    copy: [
      "Nomior Code does not record you. In v1 it reads what your recorder already wrote — Anarlog's or Granola's local store, or a transcript file you drop in — and joins it to the calendar event and the mail thread it belongs to.",
      "One meeting entity: transcript, notes, decisions, linked from a unified calendar across every Google account you connect, with recurring series grouped by their recurrence. Mail is per label, sender or thread — never the whole mailbox.",
      "Analysis runs on the provider subscriptions you already have; search and embeddings run locally and cost nothing.",
    ],
    demo: {
      name: "calendar-week.gif",
      caption:
        "A week across two connected Google accounts, colour-coded per account; a standup opens straight into its linked transcript.",
    },
  },
  {
    id: "instances",
    eyebrow: "Multi-account",
    title: ["Sign in to the accounts", "you already have"],
    copy: [
      "Add each Claude, Codex or Grok account as its own instance. Sign-in happens inside that provider's own CLI, into that provider's own local profile — Nomior Code never reads, stores or proxies a credential, and never asks you for one.",
      "The scheduler reads the rate-limit events those CLIs already emit and suggests which instance to start a thread on, with the reason written out. It is advisory: pin an instance and the suggestion steps aside. This is a way to keep the seats you own organised, not a way around anyone's limits.",
    ],
    demo: {
      name: "scheduler-switch.gif",
      caption:
        "One instance reports a rate limit; the next thread is suggested on another, with the reason spelled out on the card.",
    },
  },
  {
    id: "review",
    eyebrow: "Review engine",
    title: ["A second model", "reads every diff"],
    copy: [
      "Each review leg runs on the instance and model you choose, against your repo's playbook — the Verify, Context and Bar sections you actually edit. The verdict gate that decides pass or fail is deterministic code, not a model's opinion, and nothing reaches your forge until you approve it.",
      "Cards move across an in-app board — Queue, Reviewing, Waiting external, Approved, Not approved — carrying severity and evidence. Hand any card to a human in one action. Approved findings become memory candidates, so the same mistake does not ship twice.",
    ],
    demo: {
      name: "review-board.gif",
      caption:
        "A card crosses the board from Queue to a verdict, evidence attached, without leaving the app.",
    },
  },
  {
    id: "setups",
    eyebrow: "Setups",
    title: ["Your whole configuration,", "versioned"],
    copy: [
      "Skills, agents, review playbooks, MCP servers and memory templates bundle into a setup — a git repository under the hood, auto-committed on change, scanned for secrets before every commit, shared from your own GitHub.",
      "Import shows a diff before it applies anything, and drift against what you applied is literally a git diff. Teams push one baseline with role overlays to every seat. Secrets are structurally excluded: a setup carries references, never values.",
    ],
  },
];

export function Features() {
  return (
    <section className="scroll-mt-20 border-t border-line/60 py-28 md:py-40" id="features">
      <div className="mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <div className="flex flex-col gap-28 md:gap-40">
          {FEATURES.map((feature, index) => (
            <article className="scroll-mt-24" id={feature.id} key={feature.id}>
              <Reveal className="max-w-[62ch]">
                <Eyebrow>{feature.eyebrow}</Eyebrow>
              </Reveal>
              <TitleLines
                className="mt-4 max-w-[22ch] text-2xl font-semibold tracking-tighter md:text-4xl"
                lines={feature.title}
              />
              <Reveal className="max-w-[62ch]" delay={0.06}>
                {feature.copy.map((paragraph) => (
                  <p className="mt-4 leading-relaxed text-fog" key={paragraph.slice(0, 24)}>
                    {paragraph}
                  </p>
                ))}
              </Reveal>
              {feature.demo ? (
                <Reveal delay={0.1}>
                  <DemoFigure
                    available
                    caption={feature.demo.caption}
                    index={`${String(index + 1).padStart(2, "0")} / 0${FEATURES.length}`}
                    name={feature.demo.name}
                  />
                </Reveal>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
