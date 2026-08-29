/**
 * Binds the review engine's `MemoryCandidateSink` port to the one memory
 * candidate store, so a review finding and an agent's `context_remember` land
 * in the same table with the same pending-approval semantics.
 *
 * Review candidates carry no scope: a review is about a repo, and a repo is
 * not automatically a Nomior project. They list as unscoped pending candidates
 * and the user assigns a scope when approving — `MemoryCandidateStore.approve`
 * refuses an unscoped candidate rather than guessing, because nothing enters
 * the broker unscoped.
 *
 * @module nomior/memory/ReviewSinkLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MemoryCandidateSink } from "../review/MemoryCandidates.ts";
import { MemoryCandidateStore } from "./MemoryCandidateStore.ts";

export const MemoryCandidateSinkLive = Layer.effect(
  MemoryCandidateSink,
  Effect.gen(function* () {
    const store = yield* MemoryCandidateStore;
    return MemoryCandidateSink.of({
      offer: (candidate) =>
        store
          .offer({
            source: "review",
            scope: null,
            originRef: `${candidate.repo}@${candidate.headSha}`,
            kind: candidate.kind,
            ...(candidate.severity === undefined ? {} : { severity: candidate.severity }),
            text: candidate.text,
          })
          .pipe(
            // The sink's port signature is infallible on purpose: a review must
            // not fail because a candidate could not be filed. A write error is
            // logged and the verdict stands.
            Effect.catchTag("NomiorContextSqlError", (error) =>
              Effect.logWarning("nomior: memory candidate write failed", { error }),
            ),
            Effect.asVoid,
          ),
    });
  }),
);
