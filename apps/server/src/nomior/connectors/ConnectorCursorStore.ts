/**
 * ConnectorCursorStore — durable incremental-sync cursors.
 *
 * One row per (account, stream) in `nomior_connector_cursors`. A stream is
 * a driver-defined sub-feed of an account (a Google calendar id, a Gmail
 * selector set, an Anarlog store) so one account can hold several
 * independent cursors. Cursor text is driver-opaque.
 *
 * @module nomior/connectors/ConnectorCursorStore
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { ConnectorAccountId } from "./Records.ts";

export class ConnectorCursorStore extends Context.Service<
  ConnectorCursorStore,
  {
    readonly get: (
      accountId: ConnectorAccountId,
      streamId: string,
    ) => Effect.Effect<Option.Option<string>, PersistenceSqlError>;
    readonly set: (
      accountId: ConnectorAccountId,
      streamId: string,
      cursor: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly clear: (
      accountId: ConnectorAccountId,
      streamId: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    /** Drop every cursor of an account — used on revoke/reconnect. */
    readonly clearAccount: (
      accountId: ConnectorAccountId,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/nomior/connectors/ConnectorCursorStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  return ConnectorCursorStore.of({
    get: (accountId, streamId) =>
      sql<{ readonly cursor: string }>`
        SELECT cursor
        FROM nomior_connector_cursors
        WHERE account_id = ${accountId} AND stream_id = ${streamId}
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.cursor)),
        Effect.mapError(toPersistenceSqlError("connectorCursors.get")),
        Effect.withSpan("ConnectorCursorStore.get"),
      ),
    set: (accountId, streamId, cursor) =>
      nowIso.pipe(
        Effect.flatMap(
          (updatedAt) =>
            sql`
              INSERT INTO nomior_connector_cursors (account_id, stream_id, cursor, updated_at)
              VALUES (${accountId}, ${streamId}, ${cursor}, ${updatedAt})
              ON CONFLICT (account_id, stream_id)
              DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
            `,
        ),
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorCursors.set")),
        Effect.withSpan("ConnectorCursorStore.set"),
      ),
    clear: (accountId, streamId) =>
      sql`
        DELETE FROM nomior_connector_cursors
        WHERE account_id = ${accountId} AND stream_id = ${streamId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorCursors.clear")),
        Effect.withSpan("ConnectorCursorStore.clear"),
      ),
    clearAccount: (accountId) =>
      sql`
        DELETE FROM nomior_connector_cursors
        WHERE account_id = ${accountId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorCursors.clearAccount")),
        Effect.withSpan("ConnectorCursorStore.clearAccount"),
      ),
  });
});

export const layer = Layer.effect(ConnectorCursorStore, make);
