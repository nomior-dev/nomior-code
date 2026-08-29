/**
 * ContextIngestAdapter — the one place connector output becomes context.
 *
 * Every driver (Gmail, Google Calendar) emits the same
 * `ConnectorRecord`; this module turns one into a `SourceInput` and hands it to
 * `ContextIngest`. Nothing else in the connector tree knows the broker exists,
 * and nothing in the broker knows a connector exists.
 *
 * Two decisions the adapter owns:
 *
 * - **External id.** `${driverKind}:${accountId}:${sourceId}`. Record ids are
 *   only unique within `(driverKind, accountId)` (see `Records.ts`), so the
 *   account has to be in the key or two Google accounts would overwrite each
 *   other's meetings on re-sync.
 * - **Kind.** The connector catalog is finer than the broker's. The broker kind
 *   is what retrieval filters on; the exact connector kind survives in
 *   `provenance.connectorKind`, so nothing is lost.
 *
 *   | connector          | broker     |
 *   | ------------------ | ---------- |
 *   | meeting_transcript | `meeting`  |
 *   | meeting_notes      | `document` |
 *   | calendar_event     | `document` |
 *   | mail_message       | `email`    |
 *
 * Scope is the caller's: which project a meeting belongs to is a product
 * decision, not a driver's, and `SourceInput` refuses an unscoped source.
 *
 * @module nomior/connectors/ContextIngestAdapter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ContextIngest } from "../context/Ingest.ts";
import type {
  IngestResult,
  NomiorContextError,
  NomiorScope,
  NomiorSourceKind,
  SourceInput,
  SourceSegment,
} from "../context/Model.ts";
import type { ConnectorRecord, ConnectorSourceKind } from "./Records.ts";

export const toBrokerSourceKind = (kind: ConnectorSourceKind): NomiorSourceKind => {
  switch (kind) {
    case "meeting_transcript":
      return "meeting";
    case "meeting_notes":
    case "calendar_event":
      return "document";
    case "mail_message":
      return "email";
  }
};

export const connectorExternalId = (record: ConnectorRecord): string =>
  `${record.source.provenance.driverKind}:${record.source.provenance.accountId}:${record.source.sourceId}`;

/** Millisecond offsets from the record become the broker's second offsets. */
const toSeconds = (ms: number | undefined): number | undefined =>
  ms === undefined ? undefined : ms / 1000;

/**
 * One connector record → one broker source. Pure, so the mapping is testable
 * without a database.
 *
 * Empty-text chunks are dropped: `SourceSegment.text` is a non-empty trimmed
 * string, and a driver that emits a blank chunk (an empty note paragraph)
 * must not fail the whole record's ingest.
 */
export const connectorRecordToSourceInput = (
  record: ConnectorRecord,
  scopes: readonly [NomiorScope, ...ReadonlyArray<NomiorScope>],
): SourceInput => {
  const segments: Array<SourceSegment> = [];
  for (const chunk of [...record.chunks].sort((left, right) => left.index - right.index)) {
    const text = chunk.text.trim();
    if (text.length === 0) {
      continue;
    }
    const tsStart = toSeconds(chunk.startMs);
    const tsEnd = toSeconds(chunk.endMs);
    segments.push({
      text,
      ...(chunk.speaker === undefined ? {} : { speaker: chunk.speaker }),
      ...(tsStart === undefined ? {} : { tsStart }),
      ...(tsEnd === undefined ? {} : { tsEnd }),
    });
  }

  return {
    kind: toBrokerSourceKind(record.source.kind),
    externalId: connectorExternalId(record),
    title: record.source.title.trim().length === 0 ? "(untitled)" : record.source.title,
    ...(record.source.startedAt === undefined ? {} : { occurredAt: record.source.startedAt }),
    provenance: {
      connector: record.source.provenance.driverKind,
      accountId: record.source.provenance.accountId,
      externalId: record.source.provenance.externalId,
      connectorKind: record.source.kind,
      ...(record.source.provenance.externalUpdatedAt === undefined
        ? {}
        : { externalUpdatedAt: record.source.provenance.externalUpdatedAt }),
      links: record.source.links,
      participants: record.source.participants,
    },
    scopes,
    segments,
  };
};

export interface ConnectorContextIngestShape {
  /** Ingest one record. Re-ingesting the same record replaces its source atomically. */
  readonly ingestRecord: (
    record: ConnectorRecord,
    scopes: readonly [NomiorScope, ...ReadonlyArray<NomiorScope>],
  ) => Effect.Effect<IngestResult, NomiorContextError>;
  /**
   * Ingest a sync batch in order. Sequential on purpose: ingest is one
   * transaction per source against a single sqlite connection, and the
   * embedding work it enqueues is already the concurrent part.
   */
  readonly ingestBatch: (
    records: ReadonlyArray<ConnectorRecord>,
    scopes: readonly [NomiorScope, ...ReadonlyArray<NomiorScope>],
  ) => Effect.Effect<ReadonlyArray<IngestResult>, NomiorContextError>;
}

export class ConnectorContextIngest extends Context.Service<
  ConnectorContextIngest,
  ConnectorContextIngestShape
>()("t3/nomior/connectors/ContextIngestAdapter/ConnectorContextIngest") {}

export const make = Effect.gen(function* () {
  const ingest = yield* ContextIngest;

  const ingestRecord: ConnectorContextIngestShape["ingestRecord"] = (record, scopes) =>
    ingest.ingestSource(connectorRecordToSourceInput(record, scopes));

  return ConnectorContextIngest.of({
    ingestRecord,
    ingestBatch: (records, scopes) =>
      Effect.forEach(records, (record) => ingestRecord(record, scopes)),
  });
});

export const ConnectorContextIngestLive = Layer.effect(ConnectorContextIngest, make);
