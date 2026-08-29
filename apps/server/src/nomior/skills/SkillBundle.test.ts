import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SkillBundle from "./SkillBundle.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(SkillBundle.layer),
  Layer.provideMerge(NodeServices.layer),
);

const CANONICAL_SKILL_PATH = NodeURL.fileURLToPath(
  new URL("../../../../../resources/nomior-skill/SKILL.md", import.meta.url),
);

const makeTempWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "nomior-skill-" });
});

describe("skill frontmatter", () => {
  it("parses the bundled skill's agentskills.io frontmatter", () => {
    const frontmatter = SkillBundle.parseSkillFrontmatter(SkillBundle.NOMIOR_SKILL_MARKDOWN);
    expect(frontmatter.kind).toBe("parsed");
    if (frontmatter.kind === "parsed") {
      expect(frontmatter.name).toBe(SkillBundle.NOMIOR_SKILL_NAME);
      expect(frontmatter.description).toBeDefined();
      // The description is the trigger surface: it must name the tools so a
      // client knows when to load the policy body.
      for (const toolName of [
        "context_search",
        "context_get",
        "context_decisions",
        "context_remember",
      ]) {
        expect(frontmatter.description).toContain(toolName);
      }
    }
  });

  it("reports missing and malformed frontmatter instead of guessing", () => {
    expect(SkillBundle.parseSkillFrontmatter("# no frontmatter").kind).toBe("missing");
    expect(SkillBundle.parseSkillFrontmatter("---\n[a, b\n---\nbody").kind).toBe("malformed");
  });
});

it.layer(TestLayer)("SkillBundle", (it) => {
  it.effect("the embedded skill stays byte-identical to resources/nomior-skill/SKILL.md", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const canonical = yield* fileSystem.readFileString(CANONICAL_SKILL_PATH);
      expect(SkillBundle.NOMIOR_SKILL_MARKDOWN).toBe(canonical);
    }),
  );

  it.effect("materializes into .agents/skills and .claude/skills on explicit request", () =>
    Effect.gen(function* () {
      const bundle = yield* SkillBundle.SkillBundle;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* makeTempWorkspace;

      for (const flavor of ["agents", "claude"] as const) {
        const result = yield* bundle.materialize({ workspaceRoot, flavor });
        expect(result.written).toBe(true);
        expect(result.path).toBe(
          path.join(workspaceRoot, `.${flavor}`, "skills", "nomior-context", "SKILL.md"),
        );
        const written = yield* fileSystem.readFileString(result.path);
        expect(written).toBe(SkillBundle.NOMIOR_SKILL_MARKDOWN);
        const frontmatter = SkillBundle.parseSkillFrontmatter(written);
        expect(frontmatter.kind).toBe("parsed");
      }
    }),
  );

  it.effect("is idempotent when the identical skill is already in place", () =>
    Effect.gen(function* () {
      const bundle = yield* SkillBundle.SkillBundle;
      const workspaceRoot = yield* makeTempWorkspace;
      const first = yield* bundle.materialize({ workspaceRoot, flavor: "agents" });
      expect(first.written).toBe(true);
      const second = yield* bundle.materialize({ workspaceRoot, flavor: "agents" });
      expect(second.written).toBe(false);
      expect(second.path).toBe(first.path);
    }),
  );

  it.effect("refuses to clobber a diverged skill file unless overwrite is passed", () =>
    Effect.gen(function* () {
      const bundle = yield* SkillBundle.SkillBundle;
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeTempWorkspace;
      const { path: skillPath } = yield* bundle.materialize({ workspaceRoot, flavor: "claude" });
      yield* fileSystem.writeFileString(skillPath, "---\nname: user-edited\n---\ncustomized");

      const conflict = yield* bundle
        .materialize({ workspaceRoot, flavor: "claude" })
        .pipe(Effect.flip);
      expect(conflict._tag).toBe("SkillBundleConflictError");

      const overwritten = yield* bundle.materialize({
        workspaceRoot,
        flavor: "claude",
        overwrite: true,
      });
      expect(overwritten.written).toBe(true);
      const restored = yield* fileSystem.readFileString(skillPath);
      expect(restored).toBe(SkillBundle.NOMIOR_SKILL_MARKDOWN);
    }),
  );
});
