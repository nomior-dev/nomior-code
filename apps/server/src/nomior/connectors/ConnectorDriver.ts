/**
 * ConnectorDriver / ConnectorInstance — data-source SPI as plain values.
 *
 * Deliberately the same shape as upstream's `ProviderDriver`: a driver is a
 * record (not a Context.Service) because tags are singleton-per-runtime and
 * we need many instances of the same driver — one per connected account.
 * The thing a driver produces (`ConnectorInstance`) is also a record of
 * captured closures owned by that account; stopping one account's instance
 * cannot affect another.
 *
 * Driver factories are functions of `(typed config, account identity)`
 * where the config was decoded once by the caller via `configSchema`, so
 * drivers never deal with raw `unknown`. `R` is the union of
 * infrastructure services the driver needs (FileSystem, SqlClient, network
 * ports, …); the registry layer's R is the union across drivers.
 *
 * @module nomior/connectors/ConnectorDriver
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type {
  ConnectorDriverError,
  ConnectorSchemaVersionError,
  ConnectorSelectorRequiredError,
  ConnectorSyncError,
} from "./Errors.ts";
import type { ConnectorAccountId, ConnectorDriverKind, ConnectorSyncResult } from "./Records.ts";

export interface ConnectorDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Google Calendar"). */
  readonly displayName: string;
  /**
   * Whether more than one account of this driver may be connected at once.
   * Defaults to `true` — multi-account is the norm; set `false` only for
   * drivers wrapping a machine-global resource.
   */
  readonly supportsMultipleAccounts?: boolean;
}

/**
 * Result of a capability probe: is this source present and usable on this
 * machine right now? Cheap, side-effect free, safe to poll.
 */
export interface ConnectorProbeResult {
  /** The underlying source exists (store file found, API reachable). */
  readonly present: boolean;
  /** We hold whatever authorization the source needs (token, read access). */
  readonly authorized: boolean;
  readonly detail?: string;
}

/**
 * Visible degradation states. `awaiting-update` is the Anarlog
 * unknown-schema contract: the store is present but its schema is outside
 * the tested range, so the driver reads only via stable fallback surfaces
 * until the connector ships an update. `needs-selection` is the Gmail
 * opt-in contract: connected but refusing to sync until the user picks
 * labels/senders/threads.
 */
export type ConnectorHealth =
  | { readonly _tag: "ok" }
  | { readonly _tag: "unavailable"; readonly detail: string }
  | { readonly _tag: "unauthorized"; readonly detail: string }
  | { readonly _tag: "needs-selection"; readonly detail: string }
  | { readonly _tag: "awaiting-update"; readonly detail: string };

export interface ConnectorSyncInput {
  /** Cursor returned by the previous sync, or `null` for a first sync. */
  readonly cursor: string | null;
}

/** Union of everything `sync` may fail with. */
export type ConnectorSyncFailure =
  | ConnectorSyncError
  | ConnectorSelectorRequiredError
  | ConnectorSchemaVersionError;

/**
 * One materialized connector account. All closures are captured per
 * account — two accounts of the same driver share no mutable state.
 */
export interface ConnectorInstance {
  readonly accountId: ConnectorAccountId;
  readonly driverKind: ConnectorDriverKind;
  readonly displayName: string | undefined;
  /** Capability probe — is the source present/authorized on this machine? */
  readonly probe: Effect.Effect<ConnectorProbeResult, ConnectorDriverError>;
  /**
   * One incremental sync step. Feed the cursor from the previous result;
   * persist `nextCursor` from this one. Must never write to the source.
   */
  readonly sync: (
    input: ConnectorSyncInput,
  ) => Effect.Effect<ConnectorSyncResult, ConnectorSyncFailure>;
  /** Current health/degradation status, for visible-not-silent surfacing. */
  readonly health: Effect.Effect<ConnectorHealth>;
  /**
   * Disconnect this account: drop stored credentials and per-account
   * state the driver owns. Cursor rows are the caller's to clear.
   */
  readonly revoke: Effect.Effect<void, ConnectorDriverError>;
}

export interface ConnectorDriverCreateInput<Config> {
  readonly accountId: ConnectorAccountId;
  readonly displayName: string | undefined;
  readonly config: Config;
}

export interface ConnectorDriver<Config, R = never> {
  readonly driverKind: ConnectorDriverKind;
  readonly metadata: ConnectorDriverMetadata;
  /**
   * Decoder for the opaque per-account config envelope. Callers run this
   * exactly once per account (re)load. `Codec<Config, unknown>` for the
   * same reason as `ProviderDriver.configSchema`: it pins
   * `DecodingServices = never` so the erased driver type cannot poison the
   * R channel of `decodeUnknownEffect` callers.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /**
   * Materialize one account instance. Runs in a scope owned by the caller;
   * closing that scope releases every resource the driver opened. Failures
   * must surface as `ConnectorDriverError` — never defects.
   */
  readonly create: (
    input: ConnectorDriverCreateInput<Config>,
  ) => Effect.Effect<ConnectorInstance, ConnectorDriverError, R | Scope.Scope>;
}

// `any` intentionally erases the per-driver Config — callers decoded it via
// `configSchema` before invoking `create`, so downstream code never needs
// the original type; `unknown` would force casts inside driver bodies.
// Same erasure as upstream's `AnyProviderDriver`.
export type AnyConnectorDriver<R = never> = ConnectorDriver<any, R>;
