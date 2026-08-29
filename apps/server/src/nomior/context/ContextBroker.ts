/**
 * ContextBroker - the default wiring of the context broker services.
 *
 * Provides ingest, retrieval and the embedding worker over their default
 * seams (deterministic contextual prefixer, offline hash embedding model,
 * identity reranker). Requires only `SqlClient` (with migrations applied).
 *
 * Swap a seam by providing the alternative layer before this one — e.g. a
 * real embedding model via `layerRegistry`, or an LLM `ContextualPrefixer`.
 *
 * @module ContextBroker
 */
import * as Layer from "effect/Layer";

import { EmbeddingModelRegistryDefault, EmbeddingWorkerLive } from "./Embeddings.ts";
import { ContextIngestLive, ContextualPrefixerDeterministic } from "./Ingest.ts";
import { ContextRetrievalLive, RerankerIdentity } from "./Retrieval.ts";

export const ContextBrokerLive = Layer.mergeAll(ContextIngestLive, ContextRetrievalLive).pipe(
  Layer.provideMerge(EmbeddingWorkerLive),
  Layer.provide(
    Layer.mergeAll(
      EmbeddingModelRegistryDefault,
      ContextualPrefixerDeterministic,
      RerankerIdentity,
    ),
  ),
);
