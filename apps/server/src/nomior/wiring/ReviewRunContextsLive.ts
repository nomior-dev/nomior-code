/**
 * ReviewRunContextsLive — a job's review context, read from its own checkout.
 *
 * The playbook is the judgment half of a review (`review/Playbook.ts`), and
 * judgment is per repo, so it lives in the repo: `.nomior/review.md`, with the
 * `## Verify` / `## Context` / `## Bar` sections the parser requires. Nomior
 * finds the checkout by matching the job's repo against the projects this
 * environment has, which is the same lookup the memory sink uses.
 *
 * A repo without a readable, complete playbook resolves as `absent` rather
 * than failing. That is deliberate and is the gate's existing rule: the review
 * still runs and still reports findings, it just cannot end in an approval.
 * Silently treating a half-written playbook as present would turn a
 * configuration mistake into an approval.
 *
 * Leg configuration is passed in rather than read from the repo: which
 * accounts and models a review may spend is the operator's call, not the
 * reviewed repo's.
 *
 * @module nomior/wiring/ReviewRunContextsLive
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { NomiorProjects } from "../projects/NomiorProjects.ts";
import { parsePlaybook, type PlaybookPresence } from "../review/Playbook.ts";
import { ReviewRunContexts, type ReviewRunContext } from "../review/ReviewEngine.ts";
import type { ReviewLegConfig } from "../review/Legs.ts";
import type { ReviewJob, ReviewTarget } from "../review/Schemas.ts";

/** Where a repo keeps its playbook, relative to the checkout root. */
export const PLAYBOOK_PATH = [".nomior", "review.md"] as const;

const describeTarget = (target: ReviewTarget): string =>
  target.kind === "pull-request" ? `pull request #${target.number}` : `thread ${target.threadId}`;

/**
 * What the legs are told they are looking at. Deliberately thin: the diff
 * itself belongs to whichever leg has `git-read` attached, and a summary
 * invented here would be a second, unverified account of the change.
 */
export const changeSummaryFor = (job: ReviewJob): string =>
  `${job.repo} ${describeTarget(job.target)} at ${job.headSha} (risk: ${job.riskTier}).`;

export const make = (legs: ReadonlyArray<ReviewLegConfig>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* NomiorProjects;

    const readPlaybook = Effect.fn("ReviewRunContextsLive.readPlaybook")(function* (repo: string) {
      const project = yield* projects
        .byRepo(repo)
        .pipe(Effect.orElseSucceed(() => Option.none<{ readonly workspaceRoot: string }>()));
      if (Option.isNone(project)) return { kind: "absent" } as PlaybookPresence;

      const file = path.join(project.value.workspaceRoot, ...PLAYBOOK_PATH);
      const markdown = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
      if (markdown === null) return { kind: "absent" } as PlaybookPresence;

      const parsed = parsePlaybook(markdown);
      if (parsed._tag === "PlaybookParseFailure") {
        yield* Effect.logWarning(
          `nomior: ${file} is not a usable review playbook, so ${repo} cannot be approved`,
          { missing: parsed.missingSections, empty: parsed.emptySections },
        );
        return { kind: "absent" } as PlaybookPresence;
      }
      return { kind: "present", playbook: parsed.playbook } as PlaybookPresence;
    });

    return ReviewRunContexts.of({
      resolve: (job) =>
        readPlaybook(job.repo).pipe(
          Effect.map(
            (playbook): ReviewRunContext => ({
              legs,
              playbook,
              brief: { contextPacket: null, changeSummary: changeSummaryFor(job) },
            }),
          ),
        ),
    });
  });

/**
 * Requires `NomiorProjects`, `FileSystem` and `Path`. `legs` is the operator's
 * leg roster; an empty roster is legal and the gate reads it as no legs, which
 * it refuses to approve.
 */
export const layer = (legs: ReadonlyArray<ReviewLegConfig>) =>
  Layer.effect(ReviewRunContexts, make(legs));
