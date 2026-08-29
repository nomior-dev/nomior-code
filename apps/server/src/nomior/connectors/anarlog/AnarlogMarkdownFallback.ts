/**
 * Degraded read path: Anarlog's filesystem-sync markdown export.
 *
 * When the SQLite store's schema version is unknown (see
 * `AnarlogSchema.ts`), the driver falls back to Anarlog's stable
 * fs-sync layout instead of guessing at untested tables: a base folder of
 * per-session directories named by UUID, each holding `_meta.json`,
 * optional `_memo.md`, optional `transcript.json`, and `<uuid>.md` note
 * files with YAML frontmatter. Layout verified against anarlog's
 * `crates/fs-sync-core` (2026-08-29).
 *
 * @module nomior/connectors/anarlog/AnarlogMarkdownFallback
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ConnectorChunk, ConnectorRecord, ConnectorSource } from "../Records.ts";
import type { AnarlogNormalizeContext } from "./AnarlogNormalize.ts";

const SESSION_META_FILE = "_meta.json";
const SESSION_MEMO_FILE = "_memo.md";
const SESSION_TRANSCRIPT_FILE = "transcript.json";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AnarlogMarkdownError extends Schema.TaggedErrorClass<AnarlogMarkdownError>()(
  "AnarlogMarkdownError",
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Anarlog markdown fallback ${this.operation} failed for ${this.path}`;
  }
}

/**
 * Anarlog's real `_meta.json` participants carry only opaque ids
 * (`{id, userId, sessionId, humanId, source}` — fs-sync-core
 * `types.rs::SessionMetaParticipant`), no display name or email. The
 * optional `name`/`email` here tolerate a future export that adds them;
 * participants that decode to neither are dropped below rather than
 * emitted as empty `{}` entries.
 */
const SessionMetaParticipant = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});

const SessionMeta = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  participants: Schema.optional(Schema.Array(SessionMetaParticipant)),
});

const TranscriptWord = Schema.Struct({
  text: Schema.String,
  start_ms: Schema.Number,
  end_ms: Schema.Number,
  speaker: Schema.optional(Schema.NullOr(Schema.String)),
});

const TranscriptWithData = Schema.Struct({
  id: Schema.String,
  started_at: Schema.Number,
  words: Schema.Array(TranscriptWord),
});

const TranscriptJson = Schema.Struct({
  transcripts: Schema.Array(TranscriptWithData),
});

const decodeSessionMeta = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionMeta));
const decodeTranscriptJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptJson));

/** Minimal YAML-frontmatter split: `---\n…\n---\n` header + body. */
const splitFrontmatter = (
  content: string,
): { readonly title: string | undefined; readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (match === null) {
    return { title: undefined, body: content };
  }
  const header = match[1] ?? "";
  const titleLine = header.split(/\r?\n/).find((line) => /^title\s*:/.test(line));
  const title = titleLine
    ?.slice(titleLine.indexOf(":") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  return {
    title: title === "" ? undefined : title,
    body: content.slice(match[0].length),
  };
};

const toParagraphChunks = (sourceId: string, text: string): Array<ConnectorChunk> =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph, index) => ({
      chunkId: `${sourceId}/chunk/${index}`,
      sourceId,
      index,
      text: paragraph,
    }));

/**
 * Read every exported session under `baseDir` into connector records. The
 * fallback path has no incremental handle — callers re-read the folder and
 * dedupe by sourceId.
 */
export const readMarkdownExport = Effect.fnUntraced(function* (
  context: AnarlogNormalizeContext,
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findSessionDirs = (
    dir: string,
  ): Effect.Effect<Array<string>, AnarlogMarkdownError, never> =>
    Effect.gen(function* () {
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(
          Effect.mapError(
            (cause) => new AnarlogMarkdownError({ operation: "readDirectory", path: dir, cause }),
          ),
        );
      const found: Array<string> = [];
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const info = yield* fs
          .stat(entryPath)
          .pipe(
            Effect.mapError(
              (cause) => new AnarlogMarkdownError({ operation: "stat", path: entryPath, cause }),
            ),
          );
        if (info.type !== "Directory") {
          continue;
        }
        if (UUID_PATTERN.test(entry)) {
          found.push(entryPath);
        } else {
          found.push(...(yield* findSessionDirs(entryPath)));
        }
      }
      return found;
    });

  const readTextIfExists = (filePath: string) =>
    fs.exists(filePath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.map(fs.readFileString(filePath), (content) => content)
          : Effect.succeed(null),
      ),
      Effect.mapError(
        (cause) => new AnarlogMarkdownError({ operation: "readFile", path: filePath, cause }),
      ),
    );

  const sessionDirs = yield* findSessionDirs(baseDir);
  const records: Array<ConnectorRecord> = [];

  for (const sessionDir of sessionDirs) {
    const metaText = yield* readTextIfExists(path.join(sessionDir, SESSION_META_FILE));
    if (metaText === null) {
      continue;
    }
    const meta = yield* decodeSessionMeta(metaText).pipe(
      Effect.mapError(
        (cause) => new AnarlogMarkdownError({ operation: "decodeMeta", path: sessionDir, cause }),
      ),
    );

    const participants = (meta.participants ?? [])
      .map((participant) => ({
        ...(participant.name === null || participant.name === undefined || participant.name === ""
          ? {}
          : { name: participant.name }),
        ...(participant.email === null ||
        participant.email === undefined ||
        participant.email === ""
          ? {}
          : { email: participant.email }),
      }))
      .filter((participant) => participant.name !== undefined || participant.email !== undefined);
    const title = meta.title ?? "";
    const startedAt = meta.createdAt ?? undefined;
    const links = { meetingSessionId: meta.id };
    const meetingSourceId = `session:${meta.id}`;

    const meetingSource: ConnectorSource = {
      sourceId: meetingSourceId,
      kind: "meeting_transcript",
      title,
      ...(startedAt === undefined ? {} : { startedAt }),
      participants,
      links,
      provenance: {
        driverKind: context.driverKind,
        accountId: context.accountId,
        externalId: meta.id,
      },
    };

    const chunks: Array<ConnectorChunk> = [];
    const transcriptText = yield* readTextIfExists(path.join(sessionDir, SESSION_TRANSCRIPT_FILE));
    if (transcriptText !== null) {
      const transcriptJson = yield* decodeTranscriptJson(transcriptText).pipe(
        Effect.mapError(
          (cause) =>
            new AnarlogMarkdownError({
              operation: "decodeTranscript",
              path: sessionDir,
              cause,
            }),
        ),
      );
      for (const transcript of transcriptJson.transcripts) {
        let currentSpeaker: string | null | undefined;
        let currentWords: Array<{ text: string; start_ms: number; end_ms: number }> = [];
        const flush = () => {
          const text = currentWords
            .map((word) => word.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text !== "") {
            const index = chunks.length;
            const first = currentWords[0];
            const last = currentWords.at(-1);
            chunks.push({
              chunkId: `${meetingSourceId}/chunk/${index}`,
              sourceId: meetingSourceId,
              index,
              text,
              ...(currentSpeaker === null || currentSpeaker === undefined
                ? {}
                : { speaker: currentSpeaker }),
              ...(first === undefined ? {} : { startMs: Math.round(first.start_ms) }),
              ...(last === undefined ? {} : { endMs: Math.round(last.end_ms) }),
            });
          }
          currentWords = [];
        };
        for (const word of transcript.words) {
          if (currentWords.length > 0 && word.speaker !== currentSpeaker) {
            flush();
          }
          currentSpeaker = word.speaker;
          currentWords.push({ text: word.text, start_ms: word.start_ms, end_ms: word.end_ms });
        }
        flush();
      }
    }
    records.push({ source: meetingSource, chunks });

    const memoText = yield* readTextIfExists(path.join(sessionDir, SESSION_MEMO_FILE));
    const noteEntries = yield* fs
      .readDirectory(sessionDir)
      .pipe(
        Effect.mapError(
          (cause) =>
            new AnarlogMarkdownError({ operation: "readDirectory", path: sessionDir, cause }),
        ),
      );
    const noteFiles = noteEntries.filter(
      (entry) => entry.endsWith(".md") && UUID_PATTERN.test(entry.slice(0, -3)),
    );

    const pushNote = (noteId: string, noteTitle: string | undefined, body: string) => {
      const noteSourceId = `session:${meta.id}/note:${noteId}`;
      records.push({
        source: {
          sourceId: noteSourceId,
          kind: "meeting_notes",
          title: noteTitle ?? title,
          ...(startedAt === undefined ? {} : { startedAt }),
          participants,
          links,
          provenance: {
            driverKind: context.driverKind,
            accountId: context.accountId,
            externalId: noteId,
          },
        },
        chunks: toParagraphChunks(noteSourceId, body),
      });
    };

    if (memoText !== null && memoText.trim() !== "") {
      pushNote("memo", undefined, memoText);
    }
    for (const noteFile of noteFiles) {
      const noteText = yield* readTextIfExists(path.join(sessionDir, noteFile));
      if (noteText === null) {
        continue;
      }
      const { title: noteTitle, body } = splitFrontmatter(noteText);
      pushNote(noteFile.slice(0, -3), noteTitle, body);
    }
  }

  return records;
});
