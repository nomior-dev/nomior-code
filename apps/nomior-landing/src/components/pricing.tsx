import { Eyebrow, Reveal, TitleLines } from "./reveal";

interface Tier {
  readonly name: string;
  readonly price: string;
  readonly priceNote: string;
  readonly summary: string;
  readonly items: readonly string[];
  readonly lead?: boolean;
}

const TIERS: readonly Tier[] = [
  {
    name: "Free",
    price: "$0",
    priceNote: "local, no account",
    summary: "Everything that runs on your machine.",
    items: [
      "Capsules and project runtimes",
      "Context broker + MCP toolkit",
      "Meetings from Anarlog, Granola or a transcript file",
      "Multi-account instances and the scheduler",
      "Memory, review engine and board",
      "Setups, git-versioned, shared from your own GitHub",
    ],
    lead: true,
  },
  {
    name: "Pro",
    price: "~$15",
    priceNote: "per month · $150/yr",
    summary: "Personal features that need our servers.",
    items: [
      "End-to-end encrypted sync across your devices",
      "Remote access to your machine through our relay",
      "Share links for notes and review reports",
      "Hosted setup storage and auto-update subscriptions",
      "Cloud API, hosted MCP, webhooks, scheduled runs",
    ],
  },
  {
    name: "Team",
    price: "$30–40",
    priceNote: "per seat",
    summary: "One baseline for everyone.",
    items: [
      "Hosted review runners on the company's API keys",
      "Shared org memory and context",
      "Unified org calendars",
      "Company setup baseline + role overlays, drift visible",
      "Roles, policies, approvals, audit, admin",
    ],
  },
];

export function Pricing() {
  return (
    <section className="scroll-mt-20 border-t border-line/60 py-28 md:py-40" id="pricing">
      <div className="mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
        </Reveal>
        <TitleLines
          className="mt-5 max-w-[16ch] text-3xl font-semibold tracking-tighter md:text-5xl"
          lines={["Local is free.", "Servers are paid."]}
        />
        <Reveal className="mt-5 max-w-[58ch]" delay={0.05}>
          <p className="leading-relaxed text-fog">
            One rule sets every price: what runs on your machine costs nothing, what runs on ours
            costs money. The AI work runs on the provider subscriptions you already pay for, so
            there is no inference for us to resell and no reason to meter you.
          </p>
        </Reveal>

        <div className="mt-16 grid grid-cols-1 border-t border-line md:grid-cols-3">
          {TIERS.map((tier, index) => (
            <Reveal
              className={`border-b border-line md:border-b-0 ${
                index > 0 ? "md:border-l md:border-line" : ""
              }`}
              delay={index * 0.06}
              key={tier.name}
            >
              <div className="flex h-full flex-col py-8 md:px-7 md:first:pl-0 md:last:pr-0">
                <div className="flex items-baseline gap-3">
                  <h3 className="text-lg font-medium tracking-tight">{tier.name}</h3>
                  {tier.lead ? (
                    <span aria-hidden className="size-1.5 rounded-full bg-gold" />
                  ) : null}
                </div>
                <p className="mt-5 font-mono text-3xl tracking-tight text-cream tabular-nums">
                  {tier.price}
                </p>
                <p className="mt-1.5 font-mono text-[11px] tracking-[0.14em] text-fog-dim uppercase">
                  {tier.priceNote}
                </p>
                <p className="mt-5 text-sm leading-relaxed text-fog">{tier.summary}</p>
                <ul className="mt-6 flex flex-col gap-3 border-t border-line pt-6 text-sm leading-relaxed text-fog">
                  {tier.items.map((item) => (
                    <li className="flex gap-3" key={item}>
                      <span
                        aria-hidden
                        className={`mt-[9px] h-px w-3 shrink-0 ${
                          tier.lead ? "bg-gold" : "bg-fog-dim"
                        }`}
                      />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-8 max-w-[62ch]" delay={0.1}>
          <p className="font-mono text-xs leading-relaxed text-fog-dim">
            Enterprise — self-hosted sync and relay, compliance, managed connectors — comes later.
            Hosted transcription is not on the list at any tier: local speech-to-text is free, and
            cloud transcription runs on your own key.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
