/**
 * SkillBundle - materializes the portable Nomior context skill into a
 * project's skills directory (`.agents/skills/` or `.claude/skills/`, the two
 * project-scope roots Claude Code and Codex-compatible clients scan; see
 * `provider/Drivers/ClaudeSkills.ts` for the discovery side).
 *
 * Materialization happens ONLY on an explicit user action (a settings/UI
 * command). Nothing in the server may call `materialize` automatically -
 * writing into a user's repo unprompted violates the fork's provider-memory
 * policy (BRIEF: mirrors are explicit user-triggered exports).
 *
 * The canonical skill text lives in `resources/nomior-skill/SKILL.md`; the
 * constant below must stay byte-identical (SkillBundle.test.ts enforces it)
 * because `resources/` is not carried into the packed server bundle.
 *
 * @module nomior/skills/SkillBundle
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

export const NOMIOR_SKILL_NAME = "nomior-context";

export const NOMIOR_SKILL_MARKDOWN = `---
name: nomior-context
description: Retrieval policy for the Nomior context tools (context_search, context_get, context_decisions, context_remember). Use when a question may be answered by project history — meetings, decisions, memory, documents — or when the user states a durable fact worth remembering.
---

# Nomior context retrieval policy

Nomior gives you four MCP tools over the project's context store. Follow this
policy whenever they are available.

## Search before asking

Before asking the user about prior work, decisions, dates, people, or
agreements, run \`context_search\` with a focused query. Only ask the user when a
search (and one reformulation) came back empty.

## Cite ids

Every claim you take from a result must cite the snippet's \`id\` inline, e.g.
\`(ctx: meeting_2026-08-12_standup)\`. Never present retrieved content as your
own knowledge, and never cite an id you did not receive from a tool result.

## Fetch full documents only after a search

\`context_get\` is a drill-down, not a browser. Call it only with an \`id\` a
\`context_search\` returned in this session, and only when the snippet is not
enough. Prefer another, narrower search over expanding long sources.

## Respect scope

Results are scoped to one Nomior project. Do not try to widen scope to answer
faster, do not retry a scope-refused call with invented scope ids, and do not
mix content across scopes in one answer. If no scope resolves, tell the user to
pick the project instead of guessing.

## Respect the budget

Truncated results tell you how to narrow the query — follow that guidance
rather than raising \`budget_tokens\`. Small, precise queries beat large dumps.

## Remembering

When the user states a durable fact, preference, or decision, propose it with
\`context_remember\` in the current scope. It creates a pending candidate only:
the user approves it in Nomior. Do not claim it was saved as memory; say it was
proposed.

## Decisions and tasks

For "what did we decide" or "what is open" questions, prefer
\`context_decisions\` over free-text search — it returns structured decisions and
tasks with evidence ids you can cite.
`;

/** agentskills.io frontmatter: `---` fenced YAML with at least name + description. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

/**
 * Same tolerant shape as the module-private parser in
 * `provider/Drivers/ClaudeSkills.ts`: absent fence is "missing", unparseable
 * YAML is "malformed", and blank name/description fields are simply omitted.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export type SkillDirectoryFlavor = "agents" | "claude";

const flavorRoot: Record<SkillDirectoryFlavor, ReadonlyArray<string>> = {
  agents: [".agents", "skills"],
  claude: [".claude", "skills"],
};

export class SkillBundleWriteError extends Schema.TaggedErrorClass<SkillBundleWriteError>()(
  "SkillBundleWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write the Nomior skill to ${this.path}.`;
  }
}

export class SkillBundleConflictError extends Schema.TaggedErrorClass<SkillBundleConflictError>()(
  "SkillBundleConflictError",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `A different SKILL.md already exists at ${this.path}; pass overwrite to replace it.`;
  }
}

export interface MaterializeSkillRequest {
  readonly workspaceRoot: string;
  readonly flavor: SkillDirectoryFlavor;
  /** Replace an existing, differing SKILL.md. Defaults to false (conflict fails). */
  readonly overwrite?: boolean;
}

export interface MaterializeSkillResult {
  readonly path: string;
  /** false when an identical skill file was already in place. */
  readonly written: boolean;
}

export class SkillBundle extends Context.Service<
  SkillBundle,
  {
    /**
     * Write the Nomior context skill into the workspace. Explicit user action
     * only - never call from an automatic flow.
     */
    readonly materialize: (
      request: MaterializeSkillRequest,
    ) => Effect.Effect<MaterializeSkillResult, SkillBundleWriteError | SkillBundleConflictError>;
  }
>()("t3/nomior/skills/SkillBundle") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const materialize: SkillBundle["Service"]["materialize"] = Effect.fn("SkillBundle.materialize")(
    function* (request) {
      const skillDirectory = path.join(
        request.workspaceRoot,
        ...flavorRoot[request.flavor],
        NOMIOR_SKILL_NAME,
      );
      const skillPath = path.join(skillDirectory, "SKILL.md");
      const asWriteError = (cause: unknown) =>
        new SkillBundleWriteError({ path: skillPath, cause });

      const existing = yield* fileSystem.readFileString(skillPath).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : Effect.fail(asWriteError(error)),
        }),
      );
      if (Option.isSome(existing)) {
        if (existing.value === NOMIOR_SKILL_MARKDOWN) {
          return { path: skillPath, written: false };
        }
        if (request.overwrite !== true) {
          return yield* new SkillBundleConflictError({ path: skillPath });
        }
      }
      yield* fileSystem
        .makeDirectory(skillDirectory, { recursive: true })
        .pipe(Effect.mapError(asWriteError));
      yield* fileSystem
        .writeFileString(skillPath, NOMIOR_SKILL_MARKDOWN)
        .pipe(Effect.mapError(asWriteError));
      return { path: skillPath, written: true };
    },
  );

  return SkillBundle.of({ materialize });
});

export const layer = Layer.effect(SkillBundle, make);
