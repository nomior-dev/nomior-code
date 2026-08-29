/**
 * ConnectorSyncRunner — one manual sync of one account, end to end.
 *
 * Everything between "the user pressed Sync" and "the broker holds the new
 * sources": find the driver for the account's kind, decode its config, run the
 * driver's incremental `sync` from the persisted cursor, ingest what comes
 * back, and persist both the new cursor and the fact that a sync completed.
 *
 * Two decisions this module owns, because nothing above it can:
 *
 * - **Stream id.** Each driver here exposes exactly one feed per account (one
 *   calendar, one mailbox), so the cursor lives under a
 *   single `default` stream. A driver that grows several feeds must pick its
 *   own ids and this becomes its caller's problem, not a rename.
 * - **Scope.** `SourceInput` refuses an unscoped source and the product has no
 *   "which project does this mailbox belong to" answer yet, so an account's
 *   sources land in a capsule named after the account. That keeps two Google
 *   accounts separable, and the context panel searches every scope the broker
 *   holds, so nothing is hidden by the choice.
 *
 * @module nomior/connectors/ConnectorSyncRunner
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { NomiorScope } from "../context/Model.ts";
import {
  BUILT_IN_CONNECTORS,
  findConnectorDriver,
  type BuiltInConnectorsEnv,
} from "./builtInConnectors.ts";
import type { ConnectorAccount } from "./ConnectorAccountStore.ts";
import { ConnectorCursorStore } from "./ConnectorCursorStore.ts";
import { ConnectorSyncRunStore } from "./ConnectorSyncRunStore.ts";
import { ConnectorContextIngest } from "./ContextIngestAdapter.ts";
import { ConnectorDriverError } from "./Errors.ts";

const SYNC_STREAM_ID = "default";

/**
 * Batch caps a driver reports through `hasMore` are drained in the same run —
 * a Sync button that silently leaves a tail behind is a lying button — but a
 * bounded number of times, so one wedged account cannot hold the RPC open.
 */
const MAX_SYNC_PAGES = 10;

export interface ConnectorSyncRunResult {
  /** Sources written or refreshed by this run. */
  readonly ingested: number;
}

const accountScope = (accountId: string): NomiorScope => ({ kind: "capsule", value: accountId });

/**
 * One compiled decoder per driver. `decodeUnknownEffect` rebuilds the codec on
 * every call, and the driver set is static, so they are built once here.
 */
const configDecoders = new Map(
  BUILT_IN_CONNECTORS.map(
    (driver) => [driver.driverKind, Schema.decodeUnknownEffect(driver.configSchema)] as const,
  ),
);

/**
 * Run one sync. Requires the driver env because the driver is chosen at
 * runtime: whichever account is synced, the union of every built-in driver's
 * dependencies has to be present. The driver instance lives in this call's own
 * scope, so whatever it opened is closed before the result is returned.
 */
export const runConnectorSync = Effect.fn("nomior.connectors.runSync")(function* (
  account: ConnectorAccount,
) {
  const driver = findConnectorDriver(account.driverKind);
  const decodeConfig = configDecoders.get(account.driverKind);
  if (driver === undefined || decodeConfig === undefined) {
    return yield* new ConnectorDriverError({
      driverKind: account.driverKind,
      accountId: account.accountId,
      detail: "no driver ships with this build",
    });
  }

  const cursors = yield* ConnectorCursorStore;
  const ingest = yield* ConnectorContextIngest;
  const syncRuns = yield* ConnectorSyncRunStore;

  const config = yield* decodeConfig(account.config).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectorDriverError({
          driverKind: account.driverKind,
          accountId: account.accountId,
          detail: "stored account configuration does not match the driver's schema",
          cause,
        }),
    ),
  );

  const instance = yield* driver.create({
    accountId: account.accountId,
    displayName: account.displayName ?? undefined,
    config,
  });

  const scopes = [accountScope(account.accountId)] as const;
  let cursor = Option.getOrNull(yield* cursors.get(account.accountId, SYNC_STREAM_ID));
  let ingested = 0;

  for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
    const batch = yield* instance.sync({ cursor });
    ingested += (yield* ingest.ingestBatch(batch.records, scopes)).length;
    if (batch.nextCursor !== null) {
      yield* cursors.set(account.accountId, SYNC_STREAM_ID, batch.nextCursor);
      cursor = batch.nextCursor;
    }
    // A driver that reports more work but hands back no way to advance would
    // re-read the same page forever; stop and let the next sync retry.
    if (batch.hasMore !== true || batch.nextCursor === null) {
      break;
    }
  }

  yield* syncRuns.record(account.accountId, DateTime.formatIso(yield* DateTime.now));
  return { ingested } satisfies ConnectorSyncRunResult;
}, Effect.scoped);

export type ConnectorSyncRunnerEnv =
  | BuiltInConnectorsEnv
  | ConnectorContextIngest
  | ConnectorCursorStore
  | ConnectorSyncRunStore;
