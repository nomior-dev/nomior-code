import { Eyebrow, Reveal } from "./reveal";

interface Tier {
  readonly name: string;
  readonly price: string;
  readonly priceNote?: string;
  readonly summary: string;
  readonly items: readonly string[];
  readonly highlighted?: boolean;
}

const TIERS: readonly Tier[] = [
  {
    name: "Free",
    price: "$0",
    priceNote: "forever, local",
    summary: "Everything that runs on your machine.",
    items: [
      "Capsules, context broker + MCP, memory",
      "Meetings via Anarlog, Granola or import",
      "Multi-account instances + scheduler",
      "Review engine + board",
      "Setups, versioned and shared via your GitHub",
    ],
    highlighted: true,
  },
  {
    name: "Pro",
    price: "~$15",
    priceNote: "per month",
    summary: "Personal features that run on our servers.",
    items: [
      "End-to-end encrypted sync, multi-device",
      "Remote access through the relay",
      "Shareable links for notes and review reports",
      "Hosted setups with auto-update subscriptions",
      "Cloud API, hosted MCP, scheduled automations",
    ],
  },
  {
    name: "Team",
    price: "$30–40",
    priceNote: "per seat",
    summary: "One baseline for the whole team.",
    items: [
      "Hosted review runners on your API keys",
      "Shared org memory and context",
      "Unified org calendars",
      "Setup baseline + role overlays, drift visible",
      "Roles, approvals, audit, admin",
    ],
  },
];

export function Pricing() {
  return (
    <section className="py-32 md:py-44" id="pricing">
      <div className="mx-auto w-full max-w-[1100px] px-5 md:px-8">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">
            Local is free. Servers are paid.
          </h2>
          <p className="mt-4 max-w-xl leading-relaxed text-fog">
            The whole product runs on your machine at no cost — that is the trust story, not a
            trial. You pay only for the parts that run on ours.
          </p>
        </Reveal>
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {TIERS.map((tier, index) => (
            <Reveal delay={index * 0.07} key={tier.name}>
              <article
                className={`flex h-full flex-col rounded-[var(--radius-brand)] border p-6 ${
                  tier.highlighted ? "border-gold/60 bg-surface" : "border-line bg-surface/50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-lg font-medium tracking-tight">{tier.name}</h3>
                  <p className="font-mono text-sm">
                    <span className={tier.highlighted ? "text-gold" : "text-cream"}>
                      {tier.price}
                    </span>
                    {tier.priceNote ? (
                      <span className="ml-1.5 text-xs text-fog-dim">{tier.priceNote}</span>
                    ) : null}
                  </p>
                </div>
                <p className="mt-2 text-sm text-fog">{tier.summary}</p>
                <ul className="mt-5 flex flex-col gap-2.5 text-sm leading-relaxed text-fog">
                  {tier.items.map((item) => (
                    <li className="flex gap-2.5" key={item}>
                      <span
                        aria-hidden
                        className={`mt-[7px] size-1 shrink-0 rounded-full ${
                          tier.highlighted ? "bg-gold" : "bg-fog-dim"
                        }`}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-8" delay={0.1}>
          <p className="font-mono text-xs text-fog-dim">
            Enterprise — self-hosted sync and relay, compliance, managed connectors — comes later.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
