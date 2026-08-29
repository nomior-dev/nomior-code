/**
 * The playbook a review runs under comes from the reviewed repo's checkout.
 *
 * The cases that matter are the ones that decide whether an approval is even
 * reachable: a complete playbook is present, and anything else — no checkout,
 * no file, a half-written file — is `absent`, which the gate refuses to
 * approve under.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { NomiorProjects } from "../projects/NomiorProjects.ts";
import type { ReviewLegConfig } from "../review/Legs.ts";
import { ReviewRunContexts } from "../review/ReviewEngine.ts";
import { ReviewJobId, type ReviewJob } from "../review/Schemas.ts";
import { PLAYBOOK_PATH, layer as ReviewRunContextsLive } from "./ReviewRunContextsLive.ts";

const REPO = "nomior-dev/nomior-code";

const LEGS: ReadonlyArray<ReviewLegConfig> = [
  {
    role: "claude-verify",
    instanceId: ProviderInstanceId.make("inst-claude-main"),
    model: "opus-5",
    attachedTools: ["shell"],
  },
];

const job = (repo: string): ReviewJob => ({
  id: ReviewJobId.make("rev-1"),
  repo,
  target: { kind: "pull-request", number: 857 },
  headSha: "abc1234",
  status: "reviewing",
  pullRequestState: "open",
  riskTier: "high",
  attempts: 1,
  cooldownUntil: null,
  lastStartedAt: null,
  failureReason: null,
  verdict: null,
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-29T08:05:00.000Z",
});

const COMPLETE = [
  "# Review playbook",
  "",
  "## Verify",
  "vp test run the files you touched.",
  "",
  "## Context",
  "A fork of t3code; Nomior code is additive.",
  "",
  "## Bar",
  "No critical or high findings.",
  "",
].join("\n");

type WriteCheckout = (
  root: string,
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;

/** The resolver over a checkout this test just laid down. */
const resolveIn = (repo: string, write: WriteCheckout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "nomior-playbook-" });
    yield* Effect.orDie(write(root));
    const projects = NomiorProjects.layerStatic([
      { projectId: ProjectId.make("proj-1"), title: "Code", workspaceRoot: root, repo: REPO },
    ]);
    return yield* Effect.flatMap(ReviewRunContexts, (contexts) => contexts.resolve(job(repo))).pipe(
      Effect.provide(ReviewRunContextsLive(LEGS).pipe(Layer.provide(projects))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writePlaybook =
  (contents: string): WriteCheckout =>
  (root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(root, ...PLAYBOOK_PATH);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, contents);
    });

const nothing: WriteCheckout = () => Effect.void;

describe("ReviewRunContextsLive", () => {
  it.effect("reads the reviewed repo's own playbook", () =>
    Effect.gen(function* () {
      const context = yield* resolveIn(REPO, writePlaybook(COMPLETE));
      assert.strictEqual(context.playbook.kind, "present");
      assert.strictEqual(
        context.playbook.kind === "present" ? context.playbook.playbook.bar : null,
        "No critical or high findings.",
      );
      assert.deepStrictEqual(context.legs, LEGS);
      assert.include(context.brief.changeSummary, "pull request #857");
    }),
  );

  it.effect("a repo with no playbook file resolves absent, so it cannot be approved", () =>
    Effect.gen(function* () {
      const context = yield* resolveIn(REPO, nothing);
      assert.strictEqual(context.playbook.kind, "absent");
    }),
  );

  it.effect("a half-written playbook is absent, not a playbook with holes", () =>
    Effect.gen(function* () {
      const context = yield* resolveIn(
        REPO,
        writePlaybook("## Verify\nRun the tests.\n\n## Bar\n\n"),
      );
      assert.strictEqual(context.playbook.kind, "absent");
    }),
  );

  it.effect("a repo no checkout on this machine points at resolves absent", () =>
    Effect.gen(function* () {
      const context = yield* resolveIn("someone-else/unknown", writePlaybook(COMPLETE));
      assert.strictEqual(context.playbook.kind, "absent");
    }),
  );
});
