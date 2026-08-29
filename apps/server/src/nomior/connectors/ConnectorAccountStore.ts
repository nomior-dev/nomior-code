/**
 * ConnectorAccountStore — persistence for connected connector accounts.
 *
 * One row per connected account in `nomior_connector_accounts`. Multiple
 * accounts per driver kind are first class (the table has no uniqueness on
 * `driver_kind`); `accountId` is the only key. The `config` envelope is
 * stored as JSON and decoded by the owning driver's `configSchema` — this
 * store treats it as opaque.
 *
 * @module nomior/connectors/ConnectorAccountStore
 */
import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { ConnectorAccountId, ConnectorDriverKind } from "./Records.ts";

export const ConnectorAccountStatus = Schema.Literals(["connected", "error", "revoked"]);
export type ConnectorAccountStatus = typeof ConnectorAccountStatus.Type;

export const ConnectorAccount = Schema.Struct({
  accountId: ConnectorAccountId,
  driverKind: ConnectorDriverKind,
  displayName: Schema.NullOr(Schema.String),
  /** Opaque config envelope; the owning driver's `configSchema` decodes it. */
  config: Schema.Unknown,
  /**
   * Project this account's material belongs to, or null when nobody has said.
   * A null account's sources are reachable only by its capsule scope, which no
   * search uses — see `010_NomiorConnectorProject`.
   */
  projectId: Schema.NullOr(ProjectId),
  status: ConnectorAccountStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ConnectorAccount = typeof ConnectorAccount.Type;

const ConnectorAccountDbRow = ConnectorAccount.mapFields((fields) => ({
  ...fields,
  config: Schema.fromJsonString(Schema.Unknown),
}));

export type ConnectorAccountStoreError = PersistenceSqlError | PersistenceDecodeError;

export class ConnectorAccountStore extends Context.Service<
  ConnectorAccountStore,
  {
    readonly upsert: (account: ConnectorAccount) => Effect.Effect<void, ConnectorAccountStoreError>;
    readonly get: (
      accountId: ConnectorAccountId,
    ) => Effect.Effect<Option.Option<ConnectorAccount>, ConnectorAccountStoreError>;
    readonly listByDriver: (
      driverKind: ConnectorDriverKind,
    ) => Effect.Effect<ReadonlyArray<ConnectorAccount>, ConnectorAccountStoreError>;
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ConnectorAccount>,
      ConnectorAccountStoreError
    >;
    readonly setStatus: (
      accountId: ConnectorAccountId,
      status: ConnectorAccountStatus,
    ) => Effect.Effect<void, ConnectorAccountStoreError>;
    /** Null detaches the account, which stops scoping its sources anywhere. */
    readonly setProject: (
      accountId: ConnectorAccountId,
      projectId: ProjectId | null,
    ) => Effect.Effect<void, ConnectorAccountStoreError>;
    readonly remove: (
      accountId: ConnectorAccountId,
    ) => Effect.Effect<void, ConnectorAccountStoreError>;
  }
>()("t3/nomior/connectors/ConnectorAccountStore") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ConnectorAccountStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const accountColumns = `
  account_id AS "accountId",
  driver_kind AS "driverKind",
  display_name AS "displayName",
  config_json AS "config",
  project_id AS "projectId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ConnectorAccountDbRow,
    execute: (row) =>
      sql`
        INSERT INTO nomior_connector_accounts (
          account_id,
          driver_kind,
          display_name,
          config_json,
          project_id,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${row.accountId},
          ${row.driverKind},
          ${row.displayName},
          ${row.config},
          ${row.projectId},
          ${row.status},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (account_id)
        DO UPDATE SET
          driver_kind = excluded.driver_kind,
          display_name = excluded.display_name,
          config_json = excluded.config_json,
          project_id = excluded.project_id,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ConnectorAccountId,
    Result: ConnectorAccountDbRow,
    execute: (accountId) =>
      sql`
        SELECT ${sql.literal(accountColumns)}
        FROM nomior_connector_accounts
        WHERE account_id = ${accountId}
      `,
  });

  const listByDriverRows = SqlSchema.findAll({
    Request: ConnectorDriverKind,
    Result: ConnectorAccountDbRow,
    execute: (driverKind) =>
      sql`
        SELECT ${sql.literal(accountColumns)}
        FROM nomior_connector_accounts
        WHERE driver_kind = ${driverKind}
        ORDER BY created_at ASC
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ConnectorAccountDbRow,
    execute: () =>
      sql`
        SELECT ${sql.literal(accountColumns)}
        FROM nomior_connector_accounts
        ORDER BY created_at ASC
      `,
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  return ConnectorAccountStore.of({
    upsert: (account) =>
      upsertRow(account).pipe(
        Effect.mapError(
          toSqlOrDecodeError("connectorAccounts.upsert", "connectorAccounts.upsert.encode"),
        ),
        Effect.withSpan("ConnectorAccountStore.upsert"),
      ),
    get: (accountId) =>
      getRow(accountId).pipe(
        Effect.mapError(
          toSqlOrDecodeError("connectorAccounts.get", "connectorAccounts.get.decode"),
        ),
        Effect.withSpan("ConnectorAccountStore.get"),
      ),
    listByDriver: (driverKind) =>
      listByDriverRows(driverKind).pipe(
        Effect.mapError(
          toSqlOrDecodeError(
            "connectorAccounts.listByDriver",
            "connectorAccounts.listByDriver.decode",
          ),
        ),
        Effect.withSpan("ConnectorAccountStore.listByDriver"),
      ),
    listAll: () =>
      listAllRows().pipe(
        Effect.mapError(
          toSqlOrDecodeError("connectorAccounts.listAll", "connectorAccounts.listAll.decode"),
        ),
        Effect.withSpan("ConnectorAccountStore.listAll"),
      ),
    setStatus: (accountId, status) =>
      nowIso.pipe(
        Effect.flatMap(
          (updatedAt) =>
            sql`
              UPDATE nomior_connector_accounts
              SET status = ${status}, updated_at = ${updatedAt}
              WHERE account_id = ${accountId}
            `,
        ),
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorAccounts.setStatus")),
        Effect.withSpan("ConnectorAccountStore.setStatus"),
      ),
    setProject: (accountId, projectId) =>
      nowIso.pipe(
        Effect.flatMap(
          (updatedAt) =>
            sql`
              UPDATE nomior_connector_accounts
              SET project_id = ${projectId}, updated_at = ${updatedAt}
              WHERE account_id = ${accountId}
            `,
        ),
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorAccounts.setProject")),
        Effect.withSpan("ConnectorAccountStore.setProject"),
      ),
    remove: (accountId) =>
      sql`
        DELETE FROM nomior_connector_accounts
        WHERE account_id = ${accountId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("connectorAccounts.remove")),
        Effect.withSpan("ConnectorAccountStore.remove"),
      ),
  });
});

export const layer = Layer.effect(ConnectorAccountStore, make);
