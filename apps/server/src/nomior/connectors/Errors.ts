/**
 * Typed error channel for the Nomior connector layer.
 *
 * Mirrors `provider/Errors.ts`: every failure a driver can surface is a
 * `Schema.TaggedErrorClass` so errors serialize cleanly across the RPC
 * boundary and tests can match on `_tag`.
 *
 * @module nomior/connectors/Errors
 */
import * as Schema from "effect/Schema";

export class ConnectorDriverError extends Schema.TaggedErrorClass<ConnectorDriverError>()(
  "ConnectorDriverError",
  {
    driverKind: Schema.String,
    accountId: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.accountId === undefined
      ? `Connector driver ${this.driverKind} failed: ${this.detail}`
      : `Connector driver ${this.driverKind} (account ${this.accountId}) failed: ${this.detail}`;
  }
}

export class ConnectorSyncError extends Schema.TaggedErrorClass<ConnectorSyncError>()(
  "ConnectorSyncError",
  {
    driverKind: Schema.String,
    accountId: Schema.String,
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Connector sync failed in ${this.operation} (${this.driverKind}/${this.accountId})`
      : `Connector sync failed in ${this.operation} (${this.driverKind}/${this.accountId}): ${this.detail}`;
  }
}

/**
 * Raised when a driver refuses to sync because the user has not made an
 * explicit selection of what to ingest (e.g. Gmail without chosen
 * labels/senders/threads). Deliberately its own tag so callers can route it
 * to a "needs selection" UI state instead of a generic failure.
 */
export class ConnectorSelectorRequiredError extends Schema.TaggedErrorClass<ConnectorSelectorRequiredError>()(
  "ConnectorSelectorRequiredError",
  {
    driverKind: Schema.String,
    accountId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Connector ${this.driverKind} (account ${this.accountId}) requires an explicit selection before syncing: ${this.detail}`;
  }
}

/**
 * Raised when a local-store connector (Anarlog) finds a store whose schema
 * version is outside the contract-tested range and no degraded read path is
 * available. Surfaces as the "connector awaiting update" health state —
 * never a silent misparse.
 */
export class ConnectorSchemaVersionError extends Schema.TaggedErrorClass<ConnectorSchemaVersionError>()(
  "ConnectorSchemaVersionError",
  {
    driverKind: Schema.String,
    accountId: Schema.String,
    foundVersion: Schema.String,
    supportedRange: Schema.String,
  },
) {
  override get message(): string {
    return `Connector ${this.driverKind} (account ${this.accountId}) found unknown store schema version ${this.foundVersion} (supported: ${this.supportedRange}); connector awaiting update`;
  }
}

export const ConnectorError = Schema.Union([
  ConnectorDriverError,
  ConnectorSyncError,
  ConnectorSelectorRequiredError,
  ConnectorSchemaVersionError,
]);
export type ConnectorError = typeof ConnectorError.Type;
export const isConnectorError = Schema.is(ConnectorError);
