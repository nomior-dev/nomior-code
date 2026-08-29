import { DemoFigure } from "./demo-figure";
import { Eyebrow, Reveal } from "./reveal";

interface Feature {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly copy: readonly string[];
  readonly demo?: { name: string; caption: string };
}

const FEATURES: readonly Feature[] = [
  {
    id: "context",
    eyebrow: "Context without clutter",
    title: "Ask the project, get evidence",
    copy: [
      "Meetings, documents, threads and past reviews sit behind one search. Answers come back as snippets with a source, a date and an excerpt — on a hard token budget, so your agent's context stays lean.",
      "The same broker is an MCP toolkit: any client you already use can call it. Four tools, one hot schema, no context tax.",
    ],
    demo: {
      name: "cited-answer.gif",
      caption:
        "A fork session asks about last week's decision; the broker answers with two cited snippets.",
    },
  },
  {
    id: "meetings",
    eyebrow: "Meetings into context",
    title: "What was said becomes what is known",
    copy: [
      "Recordings from Anarlog or Granola, calendar events and mail threads assemble into one meeting entity — transcript, notes and decisions linked from a unified multi-account calendar, recurring series grouped automatically.",
      "Decisions extracted from meetings land in the same searchable context your agents read.",
    ],
    demo: {
      name: "calendar-week.gif",
      caption:
        "Three Google accounts in one week view, color-coded; a standup opens straight into its transcript.",
    },
  },
  {
    id: "instances",
    eyebrow: "Multi-account instances",
    title: "Every seat you own, one scheduler",
    copy: [
      "Connect several Claude, Codex or Grok profiles as instances. The scheduler watches each provider's own rate-limit events — never your credentials — and picks the instance with headroom, explaining every choice.",
      "Advisory by default: it suggests, you decide. Pin an instance and the suggestion engine steps aside.",
    ],
    demo: {
      name: "scheduler-switch.gif",
      caption:
        "One instance throttles; the next thread routes to the other, with the reason spelled out.",
    },
  },
  {
    id: "review",
    eyebrow: "Automated review",
    title: "A second model reads every diff",
    copy: [
      "The review engine verifies changes against your per-repo playbook and posts a deterministic verdict. Cards move across an in-app board — Queue, Reviewing, Waiting external, Approved, Not approved — with severity and evidence on each one.",
      "Hand any card to a human with one action. Approved findings become memory candidates, so the same mistake doesn't ship twice.",
    ],
    demo: {
      name: "review-board.gif",
      caption: "A card crosses the board from Queue to a verdict without leaving the app.",
    },
  },
  {
    id: "setups",
    eyebrow: "Setups",
    title: "Your whole configuration, versioned",
    copy: [
      "Skills, agents, playbooks, review config and memory templates bundle into a setup — a git repo under the hood, auto-committed on change, shareable from your own GitHub.",
      "Teams push one baseline with role overlays to every seat, and drift is visible as a plain diff. Secrets are structurally excluded.",
    ],
  },
];

export function Features() {
  return (
    <section className="py-16 md:py-24" id="features">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-28 px-5 md:gap-40 md:px-8">
        {FEATURES.map((feature) => (
          <Reveal className="max-w-2xl" key={feature.id}>
            <article id={feature.id}>
              <Eyebrow>{feature.eyebrow}</Eyebrow>
              <h3 className="mt-4 text-2xl font-semibold tracking-tight md:text-4xl">
                {feature.title}
              </h3>
              {feature.copy.map((paragraph) => (
                <p className="mt-4 leading-relaxed text-fog" key={paragraph.slice(0, 24)}>
                  {paragraph}
                </p>
              ))}
              {feature.demo ? (
                <DemoFigure caption={feature.demo.caption} name={feature.demo.name} />
              ) : null}
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
