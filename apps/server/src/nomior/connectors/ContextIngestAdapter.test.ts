import { assert, describe, it } from "@effect/vitest";

import type { NomiorScope } from "../context/Model.ts";
import {
  connectorExternalId,
  connectorRecordToSourceInput,
  toBrokerSourceKind,
} from "./ContextIngestAdapter.ts";
import {
  ConnectorAccountId,
  ConnectorDriverKind,
  type ConnectorRecord,
  type ConnectorSourceKind,
} from "./Records.ts";

const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };
const recorder = ConnectorDriverKind.make("recorder");
const account = ConnectorAccountId.make("recorder_local");

const record = (overrides: Partial<ConnectorRecord> = {}): ConnectorRecord => ({
  source: {
    sourceId: "s1",
    kind: "meeting_transcript",
    title: "Weekly planning",
    startedAt: "2026-08-24T10:00:00.000Z",
    endedAt: "2026-08-24T11:00:00.000Z",
    participants: [{ name: "Ivan", email: "ivan@example.com" }],
    links: { meetingSessionId: "s1", calendarEventId: "gcal-e1" },
    provenance: {
      driverKind: recorder,
      accountId: account,
      externalId: "s1",
      externalUpdatedAt: "2026-08-24T11:05:00.000Z",
    },
    ...overrides.source,
  },
  chunks: overrides.chunks ?? [
    { chunkId: "s1/1", sourceId: "s1", index: 1, text: "Second turn.", speaker: "Olga" },
    {
      chunkId: "s1/0",
      sourceId: "s1",
      index: 0,
      text: "First turn.",
      speaker: "Ivan",
      startMs: 1_500,
      endMs: 4_000,
    },
  ],
});

describe("toBrokerSourceKind", () => {
  it("maps every connector kind onto a broker kind", () => {
    const cases: ReadonlyArray<[ConnectorSourceKind, string]> = [
      ["meeting_transcript", "meeting"],
      ["meeting_notes", "document"],
      ["calendar_event", "document"],
      ["mail_message", "email"],
    ];
    for (const [connectorKind, brokerKind] of cases) {
      assert.strictEqual(toBrokerSourceKind(connectorKind), brokerKind);
    }
  });
});

describe("connectorExternalId", () => {
  it("includes the account, since record ids are only unique per account", () => {
    assert.strictEqual(connectorExternalId(record()), "recorder:recorder_local:s1");
  });

  it("separates the same record id across two accounts of one driver", () => {
    const other = record({
      source: {
        ...record().source,
        provenance: {
          driverKind: recorder,
          accountId: ConnectorAccountId.make("recorder_work"),
          externalId: "s1",
        },
      },
    });
    assert.notStrictEqual(connectorExternalId(record()), connectorExternalId(other));
  });
});

describe("connectorRecordToSourceInput", () => {
  it("orders segments by index and converts millisecond offsets to seconds", () => {
    const input = connectorRecordToSourceInput(record(), [projectAlpha]);
    assert.deepStrictEqual(
      input.segments.map((segment) => segment.text),
      ["First turn.", "Second turn."],
    );
    assert.strictEqual(input.segments[0]?.speaker, "Ivan");
    assert.strictEqual(input.segments[0]?.tsStart, 1.5);
    assert.strictEqual(input.segments[0]?.tsEnd, 4);
    // A chunk with no timing carries none, rather than a fabricated zero.
    assert.isUndefined(input.segments[1]?.tsStart);
  });

  it("carries scope, occurrence time and connector provenance through", () => {
    const input = connectorRecordToSourceInput(record(), [projectAlpha]);
    assert.strictEqual(input.kind, "meeting");
    assert.strictEqual(input.occurredAt, "2026-08-24T10:00:00.000Z");
    assert.deepStrictEqual(input.scopes, [projectAlpha]);
    assert.strictEqual(input.provenance?.connector, "recorder");
    assert.strictEqual(input.provenance?.connectorKind, "meeting_transcript");
    assert.strictEqual(input.provenance?.accountId, "recorder_local");
  });

  it("drops blank chunks instead of failing the whole record", () => {
    const input = connectorRecordToSourceInput(
      record({
        chunks: [
          { chunkId: "s1/0", sourceId: "s1", index: 0, text: "   " },
          { chunkId: "s1/1", sourceId: "s1", index: 1, text: "Real content." },
        ],
      }),
      [projectAlpha],
    );
    assert.deepStrictEqual(
      input.segments.map((segment) => segment.text),
      ["Real content."],
    );
  });

  it("substitutes a placeholder title rather than emitting an unnamed source", () => {
    const input = connectorRecordToSourceInput(
      record({ source: { ...record().source, title: "  " } }),
      [projectAlpha],
    );
    assert.strictEqual(input.title, "(untitled)");
  });
});
