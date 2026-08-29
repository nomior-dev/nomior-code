import { assert, describe, it } from "@effect/vitest";

import { parsePlaybook, playbookConfidence, type Playbook } from "./Playbook.ts";

const FULL_PLAYBOOK = `# Repo playbook

## Verify
Run \`pnpm vitest run\` and boot the dev server once.

## Context
Monorepo; contracts live in packages/contracts.
Server code is Effect-based.

## Bar
No criticals. Type errors block. Perf regressions block.
`;

describe("parsePlaybook", () => {
  it("parses the three required sections into a typed value", () => {
    const result = parsePlaybook(FULL_PLAYBOOK);
    assert.strictEqual(result._tag, "ParsedPlaybook");
    if (result._tag !== "ParsedPlaybook") return;
    assert.match(result.playbook.verify, /pnpm vitest run/);
    assert.match(result.playbook.context, /Monorepo/);
    assert.match(result.playbook.context, /Effect-based/);
    assert.match(result.playbook.bar, /No criticals/);
  });

  it("matches headings case-insensitively and ignores unknown sections", () => {
    const result = parsePlaybook(
      "## verify\ndo it\n\n## CONTEXT\nknow it\n\n## Bar\nhold it\n\n## Notes\nignored\n",
    );
    assert.strictEqual(result._tag, "ParsedPlaybook");
    if (result._tag !== "ParsedPlaybook") return;
    assert.strictEqual(result.playbook.verify, "do it");
    assert.strictEqual(result.playbook.context, "know it");
    assert.strictEqual(result.playbook.bar, "hold it");
  });

  it("reports missing sections by name", () => {
    const result = parsePlaybook("## Verify\nrun tests\n");
    assert.strictEqual(result._tag, "PlaybookParseFailure");
    if (result._tag !== "PlaybookParseFailure") return;
    assert.deepStrictEqual(result.missingSections, ["Context", "Bar"]);
    assert.deepStrictEqual(result.emptySections, []);
  });

  it("treats an empty section as a failure, not a silent pass", () => {
    const result = parsePlaybook("## Verify\n\n## Context\nctx\n\n## Bar\nbar\n");
    assert.strictEqual(result._tag, "PlaybookParseFailure");
    if (result._tag !== "PlaybookParseFailure") return;
    assert.deepStrictEqual(result.missingSections, []);
    assert.deepStrictEqual(result.emptySections, ["Verify"]);
  });

  it("fails on an entirely empty document", () => {
    const result = parsePlaybook("");
    assert.strictEqual(result._tag, "PlaybookParseFailure");
    if (result._tag !== "PlaybookParseFailure") return;
    assert.deepStrictEqual(result.missingSections, ["Verify", "Context", "Bar"]);
  });
});

describe("playbookConfidence", () => {
  it("records an absent playbook as reduced confidence, never an error", () => {
    const playbook: Playbook = { verify: "v", context: "c", bar: "b" };
    assert.strictEqual(playbookConfidence({ kind: "present", playbook }), "full");
    assert.strictEqual(playbookConfidence({ kind: "absent" }), "reduced");
  });
});
