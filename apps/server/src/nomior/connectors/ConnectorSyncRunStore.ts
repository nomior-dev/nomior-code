/**
 * ConnectorSyncRunStore — when each account last completed a sync.
 *
 * One row per account in `nomior_connector_sync_runs` (Nomior migration 008),
 * written only by a sync run that finished. The connectors panel renders
 * "never" for a missing row, so a row that exists always means a real sync
 * happened — see the migration for why this is not a column on the accounts
 * table.
 *
 * @module nomior/connectors/ConnectorSyncRunStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { ConnectorAccountId } from "./Records.ts";

export class ConnectorSyncRunStore extends Context.Service<
  ConnectorSyncRunStore,
  {
    /** Accounts that have ever synced, keyed by account id. */
    readonly lastSyncedAt: () => Effect.Effect<ReadonlyMap<string, string>, PersistenceSqlError>;
    readonly record: (
      accountId: ConnectorAccountId,
      syncedAt: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /** Drop an account's history — used on disconnect. */
    readonly remove: (accountId: ConnectorAccountId) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/nomior/connectors/ConnectorSyncRunStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return ConnectorSyncRunStore.of({
    lastSyncedAt: () =>
      sql<{ readonly accountId: string; readonly lastSyncedAt: string }>`
        SELECT account_id AS "accountId", last_synced_at AS "lastSyncedAt"
        FROM nomior_connector_sync_runs
      `.pipe(
        Effect.map(
          (rows) => new Map(rows.map((row) => [row.accountId, row.lastSyncedAt] as const)),
        ),
        Effect.mapError(toPersistenceSqlError("connectorSyncRuns.lastSyncedAt")),
        Effect.withSpan("ConnectorSyncRunStore.lastSyncedAt"),
      ),
    record: (accountId, syncedAt) =>
      sql`
        INSERT INTO nomior_connector_sync_runs (account_id, last_synced_at)
        VALUES (${accountId}, ${syncedAt})
        ON CONFLICT (account_id)
        DO UPDATE SET last_synced_at = excluded.last_synced_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorSyncRuns.record")),
        Effect.withSpan("ConnectorSyncRunStore.record"),
      ),
    remove: (accountId) =>
      sql`
        DELETE FROM nomior_connector_sync_runs
        WHERE account_id = ${accountId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorSyncRuns.remove")),
        Effect.withSpan("ConnectorSyncRunStore.remove"),
      ),
  });
});

export const layer = Layer.effect(ConnectorSyncRunStore, make);
