// @effect-diagnostics nodeBuiltinImport:off - the Anarlog fixture store is a real on-disk sqlite file, built with raw node:sqlite/fs like AnarlogDriver.test.ts.
/**
 * Integration: connector fixture → driver sync → ingest → search, on the REAL
 * layer graph.
 *
 * Nothing is stubbed between the two ends. A genuine Anarlog store file is
 * seeded on disk, the shipped `AnarlogDriver` reads it, `ConnectorContextIngest`
 * maps its records into the broker, and the broker's own hybrid search has to
 * return the meeting with a citation.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NomiorConnectorIngestLive } from "../NomiorRuntime.ts";
import { ConnectorContextIngest } from "../connectors/ContextIngestAdapter.ts";
import { ConnectorAccountId } from "../connectors/Records.ts";
import { AnarlogDriver } from "../connectors/anarlog/AnarlogDriver.ts";
import { ANARLOG_SCHEMA_VERSION_CEILING } from "../connectors/anarlog/AnarlogSchema.ts";
import { EmbeddingWorker } from "../context/Embeddings.ts";
import type { NomiorScope } from "../context/Model.ts";
import { ContextRetrieval } from "../context/Retrieval.ts";

const layer = it.layer(
  NomiorConnectorIngestLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const accountId = ConnectorAccountId.make("anarlog_local");
const decodeConfig = Schema.decodeUnknownSync(AnarlogDriver.configSchema);
const projectAlpha: NomiorScope = { kind: "project", value: "proj-alpha" };

const seedAnarlogStore = (dir: string): string => {
  const storePath = NodePath.join(dir, "app.db");
  const db = new NodeSqlite.DatabaseSync(storePath);
  db.exec(`
    CREATE TABLE _sqlx_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      installed_on TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 1,
      checksum BLOB,
      execution_time INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      ended_at TEXT NOT NULL DEFAULT '',
      event_id TEXT NOT NULL DEFAULT '',
      external_event_id TEXT NOT NULL DEFAULT '',
      series_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      words_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE session_documents (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL DEFAULT '',
      body_format TEXT NOT NULL DEFAULT 'prosemirror_json',
      body TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE session_participants (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
  `);
  db.prepare("INSERT INTO _sqlx_migrations (version) VALUES (?)").run(
    ANARLOG_SCHEMA_VERSION_CEILING,
  );
  db.prepare(
    `INSERT INTO sessions (id, title, started_at, ended_at, external_event_id, series_id, updated_at)
     VALUES ('s1', 'Pricing review with Acme', '2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', 'gcal-e1', 'series-1', '2026-08-24T11:05:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO transcripts (id, session_id, started_at_ms, words_json, updated_at)
     VALUES ('t1', 's1', 1787565600000, ?, '2026-08-24T11:00:00.000Z')`,
  ).run(
    JSON.stringify([
      {
        text: "The",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 0,
        end_ms: 200,
      },
      {
        text: "enterprise",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 210,
        end_ms: 600,
      },
      {
        text: "discount",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 610,
        end_ms: 900,
      },
      {
        text: "stays",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 910,
        end_ms: 1100,
      },
      {
        text: "at",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 1110,
        end_ms: 1200,
      },
      {
        text: "twenty",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 1210,
        end_ms: 1500,
      },
      {
        text: "percent.",
        speaker: { type: "assigned", value: { id: "h1", label: "Ivan" } },
        start_ms: 1510,
        end_ms: 1900,
      },
    ]),
  );
  db.prepare(
    `INSERT INTO session_documents (id, session_id, kind, title, body_format, body, updated_at)
     VALUES ('d1', 's1', 'note', 'Notes', 'markdown', 'Decision: keep the enterprise discount.', '2026-08-24T11:02:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO session_participants (id, session_id, display_name, email)
     VALUES ('p1', 's1', 'Ivan', 'ivan@example.com')`,
  ).run();
  db.close();
  return storePath;
};

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nomior-integration-"))),
    (dir) => Effect.scoped(use(dir)),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

layer("nomior integration: connector → ingest → search", (it) => {
  it.effect("an Anarlog meeting reaches the broker and comes back cited", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = seedAnarlogStore(dir);
        const adapter = yield* ConnectorContextIngest;
        const retrieval = yield* ContextRetrieval;
        const worker = yield* EmbeddingWorker;

        const instance = yield* AnarlogDriver.create({
          accountId,
          displayName: undefined,
          config: decodeConfig({ storePath }),
        });
        const sync = yield* instance.sync({ cursor: null });
        assert.strictEqual(sync.records.length, 2, "transcript + note");

        const ingested = yield* adapter.ingestBatch(sync.records, [projectAlpha]);
        assert.strictEqual(ingested.length, 2);
        yield* worker.awaitIdle;

        const result = yield* retrieval.search({
          query: "enterprise discount",
          scope: projectAlpha,
        });
        assert.isAbove(result.snippets.length, 0);

        // Both records match: the transcript (kind `meeting`) and the session
        // note (kind `document`). Assert on each rather than on rank order,
        // which is the ranker's business, not the wiring's.
        const transcript = result.snippets.find((snippet) => snippet.sourceKind === "meeting");
        assert.isDefined(transcript);
        assert.include(transcript.text, "enterprise discount");
        assert.include(transcript.citation, '"Pricing review with Acme" (meeting, 2026-08-24)');
        assert.include(transcript.citation, `[${transcript.chunkId}]`);
        // The speaker label survives normalize → ingest → search.
        assert.strictEqual(transcript.speaker, "Ivan");

        const note = result.snippets.find((snippet) => snippet.sourceKind === "document");
        assert.isDefined(note);
        assert.include(note.citation, '"Notes" (document, 2026-08-24)');
      }),
    ),
  );

  it.effect("re-syncing the same store replaces sources instead of duplicating them", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const storePath = seedAnarlogStore(dir);
        const adapter = yield* ConnectorContextIngest;
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* EmbeddingWorker;

        const instance = yield* AnarlogDriver.create({
          accountId,
          displayName: undefined,
          config: decodeConfig({ storePath }),
        });
        const first = yield* instance.sync({ cursor: null });
        yield* adapter.ingestBatch(first.records, [projectAlpha]);
        const again = yield* adapter.ingestBatch(first.records, [projectAlpha]);
        yield* worker.awaitIdle;

        // The connector external id carries driver + account + record id, so
        // the second ingest replaced rather than duplicated.
        for (const result of again) {
          assert.isNotNull(result.replacedSourceId);
        }
        const rows = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS "count" FROM nomior_sources
        `;
        assert.strictEqual(rows[0]?.count, 2, "still just the transcript and the note");
      }),
    ),
  );
});
