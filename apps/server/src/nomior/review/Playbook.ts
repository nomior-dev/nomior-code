/**
 * Per-repo review playbooks: judgment separated from mechanics.
 *
 * A playbook is a markdown document with three required sections —
 * `## Verify` (how to exercise the change), `## Context` (what a reviewer
 * must know about this repo), `## Bar` (what blocks a merge). A repo without
 * a playbook is allowed, but the gate records it as reduced confidence and
 * refuses to approve.
 */
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const Playbook = Schema.Struct({
  verify: TrimmedNonEmptyString,
  context: TrimmedNonEmptyString,
  bar: TrimmedNonEmptyString,
});
export type Playbook = typeof Playbook.Type;

export const PLAYBOOK_SECTIONS = ["Verify", "Context", "Bar"] as const;
export type PlaybookSection = (typeof PLAYBOOK_SECTIONS)[number];

export type PlaybookParseResult =
  | { readonly _tag: "ParsedPlaybook"; readonly playbook: Playbook }
  | {
      readonly _tag: "PlaybookParseFailure";
      readonly missingSections: ReadonlyArray<PlaybookSection>;
      readonly emptySections: ReadonlyArray<PlaybookSection>;
    };

/**
 * Whether this repo has a playbook. `absent` is legal — the review still
 * runs — but it caps the gate at not-approved and is surfaced in the UI as
 * reduced confidence.
 */
export type PlaybookPresence =
  | { readonly kind: "present"; readonly playbook: Playbook }
  | { readonly kind: "absent" };

export const playbookConfidence = (presence: PlaybookPresence): "full" | "reduced" =>
  presence.kind === "present" ? "full" : "reduced";

/** Split a markdown document into `## Heading` → body, headings lowercased. */
const collectSections = (markdown: string): Map<string, string> => {
  const bodies = new Map<string, Array<string>>();
  let current: Array<string> | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = [];
      bodies.set((heading[1] ?? "").toLowerCase(), current);
      continue;
    }
    current?.push(line);
  }
  return new Map([...bodies].map(([name, lines]) => [name, lines.join("\n").trim()]));
};

/**
 * Parse a playbook markdown document into a typed value. Pure: markdown in,
 * a parsed playbook or a failure naming exactly what is missing. Headings
 * are matched case-insensitively; unknown sections are ignored.
 */
export const parsePlaybook = (markdown: string): PlaybookParseResult => {
  const missingSections: Array<PlaybookSection> = [];
  const emptySections: Array<PlaybookSection> = [];
  const sections = new Map<PlaybookSection, string>();
  const found = collectSections(markdown);

  for (const section of PLAYBOOK_SECTIONS) {
    const body = found.get(section.toLowerCase());
    if (body === undefined) {
      missingSections.push(section);
      continue;
    }
    if (body.length === 0) {
      emptySections.push(section);
      continue;
    }
    sections.set(section, body);
  }

  if (missingSections.length > 0 || emptySections.length > 0) {
    return { _tag: "PlaybookParseFailure", missingSections, emptySections };
  }

  return {
    _tag: "ParsedPlaybook",
    playbook: {
      verify: sections.get("Verify") ?? "",
      context: sections.get("Context") ?? "",
      bar: sections.get("Bar") ?? "",
    },
  };
};
