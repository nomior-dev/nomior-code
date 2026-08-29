import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RetrievalPort from "./RetrievalPort.ts";

const sources: ReadonlyArray<RetrievalPort.ContextSourceRecord> = [
  {
    id: "meeting_2026-08-12_standup",
    scope: "project:nomior",
    sourceKind: "meeting",
    title: "Standup 2026-08-12",
    text: "We agreed the retrieval stack uses FTS5 BM25 plus sqlite-vec with RRF fusion. Ivan owns the reranker spike.",
    date: "2026-08-12",
  },
  {
    id: "doc_pricing",
    scope: "project:nomior",
    sourceKind: "document",
    title: "Pricing notes",
    text: "Everything local is free; server-backed features are paid. Pro lands at fifteen dollars monthly.",
    date: "2026-08-20",
  },
  {
    id: "doc_other_project",
    scope: "project:juna",
    sourceKind: "document",
    title: "Juna roadmap",
    text: "The retrieval stack for Juna is unrelated and must never leak into Nomior results.",
  },
];

const decisions = [
  {
    id: "dec_1",
    project: "project:nomior",
    kind: "decision",
    statement: "Fork T3 Code instead of building a companion app.",
    decidedAt: "2026-08-29",
    evidence: [{ sourceId: "meeting_2026-08-12_standup" }],
  },
  {
    id: "dec_0",
    project: "project:nomior",
    kind: "task",
    statement: "Validate diarization on our own meeting audio.",
    decidedAt: "2026-07-01",
    evidence: [],
  },
] as const;

const seed: RetrievalPort.InMemoryContextSeed = {
  sources,
  decisions,
  threadScopes: { thread_bound: "project:nomior" },
};

const withPort = <A, E>(
  use: (port: RetrievalPort.ContextRetrievalPortShape) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(RetrievalPort.ContextRetrievalPort, use).pipe(
    Effect.provide(RetrievalPort.layerInMemory(seed)),
  );

describe("layerInMemory", () => {
  it.effect("returns scoped, ranked snippets with citable ids, spans, and dates", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const response = yield* port.search({
          query: "retrieval stack",
          scope: "project:nomior",
          limit: 10,
          responseFormat: "concise",
        });
        expect(response.totalMatches).toBe(1);
        const snippet = response.snippets[0];
        expect(snippet?.id).toBe("meeting_2026-08-12_standup");
        expect(snippet?.date).toBe("2026-08-12");
        expect(snippet?.span).toBeDefined();
        if (snippet?.span) {
          expect(
            sources[0]?.text.slice(snippet.span.start, snippet.span.end).includes("retrieval"),
          ).toBe(true);
        }
        expect(snippet?.score).toBeGreaterThan(0);
        expect(snippet?.score).toBeLessThanOrEqual(1);
      }),
    ),
  );

  it.effect("never returns sources from another scope", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const response = yield* port.search({
          query: "retrieval stack",
          scope: "project:juna",
          limit: 10,
          responseFormat: "concise",
        });
        expect(response.snippets.map((snippet) => snippet.id)).toEqual(["doc_other_project"]);
      }),
    ),
  );

  it.effect("get resolves ids only inside the caller's scope", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const found = yield* port.get({ id: "doc_pricing", scope: "project:nomior" });
        expect(found.title).toBe("Pricing notes");

        const crossScope = yield* port
          .get({ id: "doc_other_project", scope: "project:nomior" })
          .pipe(Effect.flip);
        expect(crossScope._tag).toBe("ContextSourceNotFoundError");
      }),
    ),
  );

  it.effect("decisions filter by project and since", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const all = yield* port.decisions({ project: "project:nomior" });
        expect(all.map((decision) => decision.id)).toEqual(["dec_1", "dec_0"]);
        for (const decision of all) {
          expect(decision).not.toHaveProperty("project");
        }

        const recent = yield* port.decisions({ project: "project:nomior", since: "2026-08-01" });
        expect(recent.map((decision) => decision.id)).toEqual(["dec_1"]);

        const other = yield* port.decisions({ project: "project:unknown" });
        expect(other).toEqual([]);
      }),
    ),
  );

  it.effect("an unparseable since matches nothing instead of everything", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const invalid = yield* port.decisions({ project: "project:nomior", since: "2026-99-99" });
        expect(invalid).toEqual([]);
      }),
    ),
  );

  it.effect("authorizeScope allows everything without grants and enforces grants when seeded", () =>
    Effect.gen(function* () {
      // No grants seeded for the thread: single-user trust default, allow-all.
      const openPort = yield* RetrievalPort.ContextRetrievalPort.pipe(
        Effect.provide(RetrievalPort.layerInMemory(seed)),
      );
      yield* openPort.authorizeScope({ threadId: "thread_bound", scope: "project:juna" });

      const restrictedPort = yield* RetrievalPort.ContextRetrievalPort.pipe(
        Effect.provide(
          RetrievalPort.layerInMemory({
            ...seed,
            threadScopeGrants: { thread_bound: ["project:granted"] },
          }),
        ),
      );
      // The thread's own default scope and granted scopes pass...
      yield* restrictedPort.authorizeScope({ threadId: "thread_bound", scope: "project:nomior" });
      yield* restrictedPort.authorizeScope({ threadId: "thread_bound", scope: "project:granted" });
      // ...anything else is denied.
      const denied = yield* restrictedPort
        .authorizeScope({ threadId: "thread_bound", scope: "project:juna" })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("ContextScopeDeniedError");
      expect(denied.message).toContain("project:juna");
    }),
  );

  it.effect("remember issues unique pending candidates and never promotes", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const first = yield* port.remember({ text: "Ivan prefers pnpm", scope: "project:nomior" });
        const second = yield* port.remember({
          text: "Deploys are on Friday",
          scope: "project:nomior",
        });
        expect(first.status).toBe("pending_approval");
        expect(second.status).toBe("pending_approval");
        expect(first.candidateId).not.toBe(second.candidateId);
      }),
    ),
  );

  it.effect("defaultScopeForThread reflects the seeded binding", () =>
    withPort((port) =>
      Effect.gen(function* () {
        const bound = yield* port.defaultScopeForThread("thread_bound");
        expect(Option.getOrUndefined(bound)).toBe("project:nomior");
        const unbound = yield* port.defaultScopeForThread("thread_unknown");
        expect(Option.isNone(unbound)).toBe(true);
      }),
    ),
  );
});

describe("layerUnavailable", () => {
  it.effect("fails closed on every retrieval call and resolves no scope", () =>
    Effect.gen(function* () {
      const port = yield* RetrievalPort.ContextRetrievalPort;
      const searchError = yield* port
        .search({ query: "x", scope: "s", limit: 1, responseFormat: "concise" })
        .pipe(Effect.flip);
      expect(searchError._tag).toBe("ContextUnavailableError");
      const rememberError = yield* port.remember({ text: "x", scope: "s" }).pipe(Effect.flip);
      expect(rememberError._tag).toBe("ContextUnavailableError");
      const authorizeError = yield* port
        .authorizeScope({ threadId: "thread", scope: "s" })
        .pipe(Effect.flip);
      expect(authorizeError._tag).toBe("ContextUnavailableError");
      const scope = yield* port.defaultScopeForThread("thread");
      expect(Option.isNone(scope)).toBe(true);
    }).pipe(Effect.provide(RetrievalPort.layerUnavailable)),
  );
});
