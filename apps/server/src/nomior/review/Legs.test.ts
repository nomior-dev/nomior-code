import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  ReviewLegTool,
  buildLegBrief,
  findUnattachedToolMentions,
  parseLegOutput,
  type LegBriefInput,
  type ReviewLegConfig,
} from "./Legs.ts";
import type { PlaybookPresence } from "./Playbook.ts";
import { ReviewLegRole } from "./Schemas.ts";

const playbookPresent: PlaybookPresence = {
  kind: "present",
  playbook: {
    verify: "Run pnpm vitest run and check the dev server boots.",
    context: "Monorepo, Effect-based server.",
    bar: "No criticals; type errors block.",
  },
};

const makeConfig = (overrides?: Partial<ReviewLegConfig>): ReviewLegConfig => ({
  role: "codex-read",
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
  attachedTools: [],
  ...overrides,
});

const briefInput: LegBriefInput = {
  playbook: playbookPresent,
  contextPacket: "Decision 2026-08-12: keep SQLite, no graph DB.",
  changeSummary: "Adds a scheduler for provider instances.",
};

describe("buildLegBrief", () => {
  it("never mentions a tool that is not attached, for any role and attachment", () => {
    const attachments: ReadonlyArray<ReadonlyArray<ReviewLegTool>> = [
      [],
      ["shell"],
      ["git-read"],
      ["web-search"],
      ["preview"],
      ["shell", "git-read"],
      [...ReviewLegTool.literals],
    ];
    for (const role of ReviewLegRole.literals) {
      for (const attachedTools of attachments) {
        for (const playbook of [playbookPresent, { kind: "absent" } as const]) {
          const brief = buildLegBrief(makeConfig({ role, attachedTools }), {
            ...briefInput,
            playbook,
          });
          assert.deepStrictEqual(
            findUnattachedToolMentions(brief, attachedTools),
            [],
            `role=${role} attached=[${attachedTools.join(",")}] playbook=${playbook.kind}`,
          );
        }
      }
    }
  });

  it("describes attached tools and only those", () => {
    const brief = buildLegBrief(makeConfig({ attachedTools: ["shell", "git-read"] }), briefInput);
    assert.match(brief, /\bshell\b/);
    assert.match(brief, /\bgit-read\b/);
    assert.notMatch(brief, /\bweb-search\b/);
    assert.notMatch(brief, /\bpreview\b/);
  });

  it("tells a tool-less leg it has no tools", () => {
    const brief = buildLegBrief(makeConfig(), briefInput);
    assert.match(brief, /no tools attached/i);
  });

  it("includes verification steps only for a leg that can execute them", () => {
    const withShell = buildLegBrief(makeConfig({ attachedTools: ["shell"] }), briefInput);
    assert.match(withShell, /How to verify/);
    assert.match(withShell, /pnpm vitest run/);

    const withoutShell = buildLegBrief(makeConfig(), briefInput);
    assert.notMatch(withoutShell, /How to verify/);
    assert.notMatch(withoutShell, /pnpm vitest run/);
  });

  it("carries the playbook bar and flags a missing playbook as reduced confidence", () => {
    const withPlaybook = buildLegBrief(makeConfig(), briefInput);
    assert.match(withPlaybook, /No criticals; type errors block\./);

    const withoutPlaybook = buildLegBrief(makeConfig(), {
      ...briefInput,
      playbook: { kind: "absent" },
    });
    assert.match(withoutPlaybook, /no review playbook/i);
    assert.match(withoutPlaybook, /Confidence is reduced/);
  });

  it("includes the context packet only when one was assembled", () => {
    const withPacket = buildLegBrief(makeConfig(), briefInput);
    assert.match(withPacket, /keep SQLite, no graph DB/);

    const withoutPacket = buildLegBrief(makeConfig(), { ...briefInput, contextPacket: null });
    assert.notMatch(withoutPacket, /Context packet/);
  });
});

describe("parseLegOutput", () => {
  it("parses a report object embedded in prose", () => {
    const result = parseLegOutput(
      "codex-read",
      [
        "Here is my review.",
        '{"findings": [{"severity": "medium", "summary": "missing index"}],',
        ' "runtimeEvidence": [{"kind": "tests-run", "detail": "vitest 12 passed"}]}',
      ].join("\n"),
    );
    assert.strictEqual(result.outcome, "parsed");
    if (result.outcome !== "parsed") return;
    assert.strictEqual(result.report.findings.length, 1);
    assert.strictEqual(result.report.findings[0]?.severity, "medium");
    assert.strictEqual(result.report.runtimeEvidence[0]?.kind, "tests-run");
    assert.strictEqual(result.report.needsExternalReview, false);
  });

  it("defaults omitted evidence fields, but findings must be stated", () => {
    const result = parseLegOutput("security", '{"findings": []}');
    assert.strictEqual(result.outcome, "parsed");
    if (result.outcome !== "parsed") return;
    assert.deepStrictEqual(result.report.findings, []);
    assert.deepStrictEqual(result.report.runtimeEvidence, []);
    assert.strictEqual(result.report.needsExternalReview, false);
  });

  it("rejects an object without findings: {} is not a clean report", () => {
    const result = parseLegOutput("security", "{}");
    assert.strictEqual(result.outcome, "unparseable");
  });

  it("rejects an incidental brace-object in prose instead of reading it as a clean report", () => {
    const result = parseLegOutput("codex-read", 'I found a bug in {"see": "prose above"}');
    assert.strictEqual(result.outcome, "unparseable");
  });

  it("treats output without JSON as unparseable", () => {
    const result = parseLegOutput("claude-verify", "LGTM, ship it");
    assert.strictEqual(result.outcome, "unparseable");
  });

  it("treats malformed JSON as unparseable", () => {
    const result = parseLegOutput("claude-verify", '{"findings": [');
    assert.strictEqual(result.outcome, "unparseable");
  });

  it("treats a schema mismatch (unknown severity) as unparseable, never coerced", () => {
    const result = parseLegOutput(
      "codex-read",
      '{"findings": [{"severity": "catastrophic", "summary": "boom"}]}',
    );
    assert.strictEqual(result.outcome, "unparseable");
  });
});
