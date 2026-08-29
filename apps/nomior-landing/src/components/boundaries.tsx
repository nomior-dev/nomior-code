import { Eyebrow, Reveal, TitleLines } from "./reveal";

/**
 * The safety invariants from the plan, stated as commitments rather than
 * features. Every line here is a constraint the code enforces, not a promise:
 * if one stops being true, the line comes off the page.
 */
const BOUNDARIES = [
  {
    never: "Never touches a credential",
    detail:
      "No token reading, no usage-endpoint polling, no proxying. Sign-in happens inside each provider's own CLI, into its own local profile, and the keys stay in your keychain.",
  },
  {
    never: "Never sends what you didn't choose",
    detail:
      "Local by default, and outbound anything is an explicit selection. The paid sync carries product data only — transcripts, context, memories, decisions — end-to-end encrypted, credentials structurally excluded.",
  },
  {
    never: "Never edits your memory files behind your back",
    detail:
      "Mirroring a fact into CLAUDE.md or AGENTS.md is an export you trigger, written between owned markers, reversible as a plain diff.",
  },
  {
    never: "Never indexes your whole mailbox",
    detail:
      "Gmail access is granted per label, sender or thread, one incremental scope at a time. Full-mailbox indexing is on the list of things this product will not do.",
  },
  {
    never: "Never posts a review before you approve it",
    detail:
      "The pass/fail gate is deterministic code reading structured findings. Comments reach GitHub, GitLab, Bitbucket or Azure only after you say so.",
  },
] as const;

export function Boundaries() {
  return (
    <section className="scroll-mt-20 border-t border-line/60 py-28 md:py-40" id="boundaries">
      <div className="mx-auto w-full max-w-[1180px] px-5 md:px-10">
        <Reveal>
          <Eyebrow>Boundaries</Eyebrow>
        </Reveal>
        <TitleLines
          className="mt-5 max-w-[18ch] text-3xl font-semibold tracking-tighter md:text-5xl"
          lines={["Five things it", "will not do"]}
        />
        <Reveal className="mt-5 max-w-[56ch]" delay={0.05}>
          <p className="leading-relaxed text-fog">
            A local-first tool is only worth the trust if the limits are written down. These are
            enforced in code, and they are the reason the local tier can be free.
          </p>
        </Reveal>

        <dl className="mt-14 border-t border-line">
          {BOUNDARIES.map((item, index) => (
            <Reveal delay={index * 0.04} key={item.never}>
              <div className="grid grid-cols-1 gap-x-10 gap-y-2 border-b border-line py-7 md:grid-cols-[1.1fr_1.4fr]">
                <dt className="flex items-baseline gap-3 text-base font-medium tracking-tight text-cream md:text-lg">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-gold" />
                  {item.never}
                </dt>
                <dd className="pl-[1.6rem] text-sm leading-relaxed text-fog md:pl-0">
                  {item.detail}
                </dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
