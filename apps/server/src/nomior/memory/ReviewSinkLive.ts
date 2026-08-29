/**
 * Binds the review engine's `MemoryCandidateSink` to `MemoryWriter`, so a
 * review finding becomes memory the moment the review settles.
 *
 * A review knows a repo, and the broker only takes scoped writes, so the repo
 * is resolved to a T3 project through `NomiorProjects.byRepo` — the checkout
 * whose git remote points at it. A repo with no project on this machine is
 * logged and skipped: guessing a scope would file the finding under the wrong
 * project, which is worse than not filing it.
 *
 * @module nomior/memory/ReviewSinkLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { NomiorProjects } from "../projects/NomiorProjects.ts";
import { MemoryCandidateSink } from "../review/MemoryCandidates.ts";
import { MemoryWriter } from "./MemoryWriter.ts";

export const MemoryCandidateSinkLive = Layer.effect(
  MemoryCandidateSink,
  Effect.gen(function* () {
    const memories = yield* MemoryWriter;
    const projects = yield* NomiorProjects;

    return MemoryCandidateSink.of({
      offer: (candidate) =>
        Effect.gen(function* () {
          const project = yield* projects.byRepo(candidate.repo);
          if (Option.isNone(project)) {
            return yield* Effect.logWarning(
              "nomior: review finding not written to memory — no project checkout for this repo",
              { repo: candidate.repo },
            );
          }
          yield* memories.write({
            source: "review",
            scope: { kind: "project", value: project.value.projectId },
            originRef: `${candidate.repo}@${candidate.headSha}`,
            kind: candidate.kind,
            ...(candidate.severity === undefined ? {} : { severity: candidate.severity }),
            text: candidate.text,
          });
        }).pipe(
          // The sink's port signature is infallible on purpose: a review must
          // not fail because a memory could not be written. The error is
          // logged and the verdict stands.
          Effect.catchCause((cause) =>
            Effect.logWarning("nomior: review memory write failed", { cause }),
          ),
          Effect.asVoid,
        ),
    });
  }),
);
