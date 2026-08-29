/**
 * The layer graph has to BUILD, not just typecheck. A missing provide inside a
 * layer is a runtime failure in Effect, so this file constructs each exported
 * composition and pulls every service out of it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  NomiorConnectorIngestLive,
  NomiorContextLive,
  NomiorReviewPortsLive,
  NomiorSchedulerLive,
} from "./NomiorRuntime.ts";
import { ConnectorContextIngest } from "./connectors/ContextIngestAdapter.ts";
import { EmbeddingWorker } from "./context/Embeddings.ts";
import { ContextIngest } from "./context/Ingest.ts";
import { ContextRetrieval } from "./context/Retrieval.ts";
import { ContextRetrievalPort } from "./context/RetrievalPort.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { MemoryWriter } from "./memory/MemoryWriter.ts";
import { LegRunner } from "./review/Legs.ts";
import { MemoryCandidateSink } from "./review/MemoryCandidates.ts";
import { ReviewJobStore } from "./review/ReviewJobStore.ts";
import { ReviewPublisher } from "./review/ReviewPublisher.ts";
import { InstanceScheduler } from "./scheduler/InstanceScheduler.ts";
import { RateLimitObserver } from "./scheduler/RateLimitObserver.ts";

const registryStub = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(undefined as ProviderInstance | undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

const database = Layer.provide(SqlitePersistenceMemory, NodeServices.layer);

/** No checkout in a test process, so no project's remote ever resolves. */
const identitiesStub = Layer.succeed(
  RepositoryIdentityResolver,
  RepositoryIdentityResolver.of({ resolve: () => Effect.succeed(null) }),
);

it.effect("NomiorContextLive builds the broker, the memory writer and the MCP port", () =>
  Effect.gen(function* () {
    yield* ContextIngest;
    yield* ContextRetrieval;
    yield* EmbeddingWorker;
    yield* MemoryWriter;
    const port = yield* ContextRetrievalPort;
    // Reachable, not merely resolvable: the port answers a real query.
    const result = yield* port.search({
      query: "nothing is ingested yet",
      scope: "project:none" as never,
      limit: 5,
      responseFormat: "concise",
    });
    assert.deepStrictEqual(result.snippets, []);
  }).pipe(
    Effect.provide(
      NomiorContextLive.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.effect("NomiorConnectorIngestLive shares that broker rather than forking a second", () =>
  Effect.gen(function* () {
    yield* ConnectorContextIngest;
    yield* ContextIngest;
  }).pipe(
    Effect.provide(
      NomiorConnectorIngestLive.pipe(
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("NomiorSchedulerLive builds without the ProviderService daemon", () =>
  Effect.gen(function* () {
    yield* InstanceScheduler;
    const observer = yield* RateLimitObserver;
    assert.deepStrictEqual(yield* observer.snapshot(), []);
  }).pipe(
    Effect.provide(
      NomiorSchedulerLive.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.effect("NomiorReviewPortsLive builds with the safe defaults bound", () =>
  Effect.gen(function* () {
    yield* ReviewJobStore;
    yield* LegRunner;
    yield* MemoryCandidateSink;
    const publisher = yield* ReviewPublisher;
    const receipt = yield* publisher.publish({} as never);
    // The shipped publisher posts nowhere, whatever the engine hands it.
    assert.isFalse(receipt.posted);
  }).pipe(
    Effect.provide(
      NomiorReviewPortsLive.pipe(
        Layer.provide(NomiorSchedulerLive),
        Layer.provide(registryStub),
        Layer.provide(identitiesStub),
        Layer.provideMerge(NomiorContextLive),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a leg cannot run against an empty instance registry", () =>
  Effect.gen(function* () {
    const runner = yield* LegRunner;
    const error = yield* runner
      .run(
        {
          role: "security",
          instanceId: ProviderInstanceId.make("codex_personal"),
          model: "gpt-5.6-sol",
          attachedTools: [],
        },
        "brief",
      )
      .pipe(Effect.flip);
    assert.include(error.detail, "not registered");
  }).pipe(
    Effect.provide(
      NomiorReviewPortsLive.pipe(
        Layer.provide(NomiorSchedulerLive),
        Layer.provide(registryStub),
        Layer.provide(identitiesStub),
        Layer.provideMerge(NomiorContextLive),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
