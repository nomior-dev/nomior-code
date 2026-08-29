/**
 * AnarlogDriver — read-only ingestion of the Anarlog desktop app's local
 * meeting store.
 *
 * Contract (PLAN.md "Meetings"): open their SQLite strictly read-only,
 * verify the applied schema version against the tested range before
 * touching data tables, and on an unknown version degrade to the markdown
 * export with a visible "awaiting-update" health state — never a silent
 * misparse, never a write, never a lock held against the running app.
 *
 * @module nomior/connectors/anarlog/AnarlogDriver
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  ConnectorDriver,
  ConnectorHealth,
  ConnectorInstance,
  ConnectorSyncFailure,
} from "../ConnectorDriver.ts";
import { ConnectorSchemaVersionError, ConnectorSyncError } from "../Errors.ts";
import { ConnectorDriverKind, type ConnectorSyncResult } from "../Records.ts";
import { locateAnarlogStore } from "./AnarlogLocator.ts";
import { readMarkdownExport } from "./AnarlogMarkdownFallback.ts";
import { normalizeSessionBundle } from "./AnarlogNormalize.ts";
import { anarlogSupportedRangeLabel, isKnownAnarlogSchemaVersion } from "./AnarlogSchema.ts";
import { openAnarlogStore } from "./AnarlogStore.ts";

const DRIVER_KIND = ConnectorDriverKind.make("anarlog");
const SYNC_BATCH_LIMIT = 50;

export const AnarlogConnectorConfig = Schema.Struct({
  /** Absolute path to `app.db`; overrides platform-default discovery. */
  storePath: Schema.optionalKey(Schema.String),
  /** Folder of Anarlog's fs-sync markdown export; enables the degraded path. */
  markdownExportPath: Schema.optionalKey(Schema.String),
});
export type AnarlogConnectorConfig = typeof AnarlogConnectorConfig.Type;

const decodeAnarlogConnectorConfig = Schema.decodeUnknownSync(AnarlogConnectorConfig);

const AnarlogCursor = Schema.Struct({
  updatedAt: Schema.String,
  sessionId: Schema.String,
});
type AnarlogCursor = typeof AnarlogCursor.Type;
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(AnarlogCursor));
const encodeCursor = (cursor: AnarlogCursor): string => JSON.stringify(cursor);

export type AnarlogDriverEnv = FileSystem.FileSystem | Path.Path;

export const AnarlogDriver: ConnectorDriver<AnarlogConnectorConfig, AnarlogDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Anarlog Meetings",
    supportsMultipleAccounts: true,
  },
  configSchema: AnarlogConnectorConfig,
  defaultConfig: (): AnarlogConnectorConfig => decodeAnarlogConnectorConfig({}),
  create: ({ accountId, displayName, config }) =>
    Effect.gen(function* () {
      const driverContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        Effect.provideContext(effect, driverContext);

      const locate = provided(
        locateAnarlogStore({
          overridePath: config.storePath,
        }),
      );

      const context = { driverKind: DRIVER_KIND, accountId };

      const syncError = (operation: string, detail?: string, cause?: unknown) =>
        new ConnectorSyncError({
          driverKind: DRIVER_KIND,
          accountId,
          operation,
          ...(detail === undefined ? {} : { detail }),
          ...(cause === undefined ? {} : { cause }),
        });

      /** Health from a fresh look at the store — no cached state to go stale. */
      const health: Effect.Effect<ConnectorHealth> = Effect.gen(function* () {
        const located = yield* locate;
        if (Option.isNone(located)) {
          return {
            _tag: "unavailable",
            detail: "Anarlog store not found on this machine",
          } as const satisfies ConnectorHealth;
        }
        const version = yield* Effect.scoped(
          Effect.flatMap(openAnarlogStore(located.value), (store) => store.schemaVersion),
        );
        if (Option.isNone(version) || !isKnownAnarlogSchemaVersion(version.value)) {
          return {
            _tag: "awaiting-update",
            detail: `Anarlog store schema ${Option.isNone(version) ? "unreadable" : version.value.toString()} is outside the tested range ${anarlogSupportedRangeLabel}; reading via markdown export only`,
          } as const satisfies ConnectorHealth;
        }
        return { _tag: "ok" } as const satisfies ConnectorHealth;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            _tag: "unavailable",
            detail: error.message,
          } as const satisfies ConnectorHealth),
        ),
      );

      const syncFromMarkdown = (
        cursor: string | null,
      ): Effect.Effect<ConnectorSyncResult, ConnectorSyncFailure> => {
        const exportPath = config.markdownExportPath;
        if (exportPath === undefined) {
          return Effect.fail(syncError("markdownFallback", "no markdown export path configured"));
        }
        return provided(readMarkdownExport(context, exportPath)).pipe(
          Effect.map(
            (records): ConnectorSyncResult => ({
              records,
              // The export folder has no incremental handle; drop the
              // SQLite cursor so a later recovered store resyncs fully.
              nextCursor: null,
              cursorInvalidated: cursor !== null,
            }),
          ),
          Effect.mapError((cause) => syncError("markdownFallback", cause.message, cause)),
        );
      };

      const sync: ConnectorInstance["sync"] = ({ cursor }) =>
        Effect.gen(function* () {
          const located = yield* locate.pipe(
            Effect.mapError((cause) => syncError("locate", undefined, cause)),
          );
          if (Option.isNone(located)) {
            return yield* syncError(
              "locate",
              "Anarlog store not found; connect Anarlog or set storePath",
            );
          }

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openAnarlogStore(located.value).pipe(
                Effect.mapError((cause) => syncError("open", cause.message, cause)),
              );
              const version = yield* store.schemaVersion.pipe(
                Effect.mapError((cause) => syncError("schemaVersion", cause.message, cause)),
              );

              if (Option.isNone(version) || !isKnownAnarlogSchemaVersion(version.value)) {
                // Unknown schema: never guess at the tables. Markdown
                // fallback when configured, visible failure otherwise.
                if (config.markdownExportPath !== undefined) {
                  return yield* syncFromMarkdown(cursor);
                }
                return yield* new ConnectorSchemaVersionError({
                  driverKind: DRIVER_KIND,
                  accountId,
                  foundVersion: Option.isNone(version) ? "unknown" : version.value.toString(),
                  supportedRange: anarlogSupportedRangeLabel,
                });
              }

              let since: AnarlogCursor | null = null;
              let cursorInvalidated = false;
              if (cursor !== null) {
                const decoded = yield* decodeCursor(cursor).pipe(
                  Effect.map(Option.some),
                  Effect.orElseSucceed(() => Option.none<AnarlogCursor>()),
                );
                if (Option.isSome(decoded)) {
                  since = decoded.value;
                } else {
                  cursorInvalidated = true;
                }
              }

              const bundles = yield* store
                .listSessionBundlesSince(since, SYNC_BATCH_LIMIT)
                .pipe(Effect.mapError((cause) => syncError("listSessions", cause.message, cause)));

              const records = bundles.flatMap((bundle) => normalizeSessionBundle(context, bundle));
              const lastBundle = bundles.at(-1);
              const nextCursor =
                lastBundle === undefined
                  ? since === null
                    ? null
                    : encodeCursor(since)
                  : encodeCursor({
                      updatedAt: lastBundle.session.effectiveUpdatedAt,
                      sessionId: lastBundle.session.id,
                    });

              return { records, nextCursor, cursorInvalidated } satisfies ConnectorSyncResult;
            }),
          );
        });

      return {
        accountId,
        driverKind: DRIVER_KIND,
        displayName,
        probe: Effect.gen(function* () {
          const located = yield* locate.pipe(Effect.orElseSucceed(() => Option.none<string>()));
          if (Option.isNone(located)) {
            return {
              present: false,
              authorized: false,
              detail: "Anarlog store not found",
            };
          }
          const readable = yield* Effect.scoped(
            Effect.flatMap(openAnarlogStore(located.value), (store) => store.schemaVersion),
          ).pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          return {
            present: true,
            authorized: readable,
            detail: located.value,
          };
        }),
        sync,
        health,
        // Local read-only source: nothing credentialed to drop.
        revoke: Effect.void,
      } satisfies ConnectorInstance;
    }),
};
