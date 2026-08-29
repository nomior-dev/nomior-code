/**
 * Handlers for the connectors RPC methods.
 *
 * Same shape as the other handler modules: kept out of `ws.ts`, taking their
 * stores as arguments so a test can drive them against a real database, and
 * turning every typed failure into the one wire error with an honest
 * `retryable`. A bad id, a missing client id or a kind that has no OAuth flow
 * will fail the same way next time; a network blip or a locked database will
 * not.
 *
 * The one rule that outranks everything here: no token, refresh token or whole
 * client id may reach the wire or the log. The panel gets `clientIdHint` — the
 * last four characters — and nothing else.
 *
 * @module nomior/rpc/connectorHandlers
 */
import {
  NomiorRequestError,
  type NomiorAnarlogState,
  type NomiorConnectorAccount,
  type NomiorConnectorKind,
  type NomiorConnectorsListResult,
  type NomiorConnectorSyncResult,
  type NomiorGoogleClientState,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import type {
  ConnectorAccount,
  ConnectorAccountStore,
} from "../connectors/ConnectorAccountStore.ts";
import type { ConnectorCursorStore } from "../connectors/ConnectorCursorStore.ts";
import { runConnectorSync } from "../connectors/ConnectorSyncRunner.ts";
import type { ConnectorSyncRunStore } from "../connectors/ConnectorSyncRunStore.ts";
import { ConnectorAccountId, ConnectorDriverKind } from "../connectors/Records.ts";
import { isKnownAnarlogSchemaVersion } from "../connectors/anarlog/AnarlogSchema.ts";
import { locateAnarlogStore } from "../connectors/anarlog/AnarlogLocator.ts";
import { openAnarlogStore } from "../connectors/anarlog/AnarlogStore.ts";
import {
  beginGoogleLoopbackAuthorization,
  completeGoogleLoopbackAuthorization,
  GMAIL_READONLY_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
} from "../connectors/google/GoogleAuth.ts";
import {
  googleClientIdHint,
  type GoogleClientIdStore,
} from "../connectors/google/GoogleClientIdStore.ts";
import type { GoogleTokenVault } from "../connectors/google/GoogleTokenVault.ts";
import {
  GmailPortLive,
  GoogleCalendarPortLive,
  GoogleClientConfig,
} from "../connectors/google/googleapisRuntime.ts";

/**
 * Failures that describe the request rather than the moment: retrying sends
 * the identical request and gets the identical answer, so the panel drops its
 * Retry. Everything else — sql, network, a driver mid-sync — keeps it.
 */
const NON_RETRYABLE_TAGS: ReadonlySet<string> = new Set([
  // The account's stored config no longer matches its driver, or no driver
  // ships for its kind: a human has to fix the row.
  "ConnectorDriverError",
  // Gmail without chosen labels/senders/threads. Sync stays refused until the
  // user picks something.
  "ConnectorSelectorRequiredError",
  // An Anarlog store outside the tested schema range. A newer Anarlog needs a
  // newer connector, not another attempt.
  "ConnectorSchemaVersionError",
]);

const failed = (fallback: string, retryable: boolean) => (cause: unknown) =>
  new NomiorRequestError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallback,
    retryable,
  });

const failedByTag = (fallback: string) => (cause: unknown) =>
  failed(
    fallback,
    !(
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      typeof cause._tag === "string" &&
      NON_RETRYABLE_TAGS.has(cause._tag)
    ),
  )(cause);

const refuse = (message: string) => new NomiorRequestError({ message, retryable: false });

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * The wire's kinds are exactly the driver slugs of the connectors this build
 * ships, so the mapping is an identity check rather than a translation.
 */
const WIRE_KINDS: ReadonlySet<string> = new Set(["googleCalendar", "gmail", "anarlog"]);

const isWireKind = (driverKind: string): driverKind is NomiorConnectorKind =>
  WIRE_KINDS.has(driverKind);

const ANARLOG_KIND = ConnectorDriverKind.make("anarlog");

/** Read scope requested per Google connector. Read-only, one product each. */
const googleScopes = (kind: "googleCalendar" | "gmail"): ReadonlyArray<string> =>
  kind === "googleCalendar" ? [GOOGLE_CALENDAR_READONLY_SCOPE] : [GMAIL_READONLY_SCOPE];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const toWireAccount = (
  account: ConnectorAccount,
  kind: NomiorConnectorKind,
  lastSyncedAt: string | undefined,
): NomiorConnectorAccount => ({
  id: account.accountId,
  kind,
  displayName: account.displayName ?? account.accountId,
  status: account.status,
  lastSyncedAt: lastSyncedAt ?? null,
  // No account row carries a failure detail today; the store records a status
  // and nothing else. Null is the honest answer until one does.
  detail: null,
});

/**
 * Where Anarlog's store is, and whether we may read it.
 *
 * `unsupportedSchema` covers both halves of "found but unreadable": a schema
 * outside the tested range, and a store with no readable migration ledger at
 * all. Neither is `notFound` — we detected the store and refuse to misread it.
 */
export const detectAnarlogState = Effect.fn("nomior.rpc.detectAnarlogState")(function* (input: {
  readonly overridePath: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const notFound = {
    detection: "notFound",
    storePath: null,
    schemaVersion: null,
  } as const satisfies NomiorAnarlogState;

  const located = yield* locateAnarlogStore(input);
  if (Option.isNone(located)) {
    return notFound;
  }
  const storePath = located.value;
  // `locateAnarlogStore` returns a configured override without checking it, so
  // a stale override reads as "store missing" rather than a broken open.
  const exists = yield* fs.exists(storePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return notFound;
  }

  const version = yield* Effect.scoped(
    Effect.flatMap(openAnarlogStore(storePath), (store) => store.schemaVersion),
  ).pipe(Effect.orElseSucceed(() => Option.none<bigint>()));

  if (Option.isNone(version) || !isKnownAnarlogSchemaVersion(version.value)) {
    return {
      detection: "unsupportedSchema",
      storePath,
      // Below `Number.MAX_SAFE_INTEGER` for any plausible `YYYYMMDDHHMMSS`
      // ledger version, and the ceiling we compare against proves the scale.
      schemaVersion: Option.isNone(version) ? null : Number(version.value),
    } as const satisfies NomiorAnarlogState;
  }

  return {
    detection: "found",
    storePath,
    schemaVersion: Number(version.value),
  } as const satisfies NomiorAnarlogState;
});

/** The Anarlog driver's one config key, read without decoding the envelope. */
const readStorePath = (config: unknown): string | undefined => {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }
  const storePath = (config as { readonly storePath?: unknown }).storePath;
  return typeof storePath === "string" && storePath.length > 0 ? storePath : undefined;
};

export interface ConnectorListDeps {
  readonly accounts: ConnectorAccountStore["Service"];
  readonly syncRuns: ConnectorSyncRunStore["Service"];
  readonly clientIds: GoogleClientIdStore["Service"];
  /**
   * Whether the client asking is on this machine. Computed per connection in
   * `ws.ts` from the socket the upgrade arrived on — see
   * `rpc/clientLocality.ts` for what the signal can and cannot tell.
   */
  readonly canStartLocalOAuth: boolean;
}

export const listConnectors = Effect.fn("nomior.rpc.listConnectors")(function* (
  deps: ConnectorListDeps,
) {
  const stored = yield* deps.accounts
    .listAll()
    .pipe(Effect.mapError(failed("Connectors are unavailable.", true)));
  const lastSyncedAt = yield* deps.syncRuns
    .lastSyncedAt()
    .pipe(Effect.mapError(failed("Connectors are unavailable.", true)));
  const clientId = yield* deps.clientIds.get.pipe(
    Effect.mapError(failed("The Google client id is unreadable.", true)),
  );

  // Resolved before the account loop: an Anarlog row's stored status says what
  // was true when it was connected, and the store can have moved or been
  // uninstalled since. Detection is the live fact and wins.
  const anarlogAccount = stored.find((account) => account.driverKind === ANARLOG_KIND);
  const overridePath =
    anarlogAccount === undefined ? undefined : readStorePath(anarlogAccount.config);
  const anarlog = yield* detectAnarlogState({ overridePath });

  const accounts: Array<NomiorConnectorAccount> = [];
  for (const account of stored) {
    if (!isWireKind(account.driverKind)) {
      // A row for a driver this build does not ship. Dropping it keeps the
      // panel alive; the warning is how it stops being invisible.
      yield* Effect.logWarning("nomior: connector account has an unknown driver kind", {
        accountId: account.accountId,
        driverKind: account.driverKind,
      });
      continue;
    }
    const wire = toWireAccount(account, account.driverKind, lastSyncedAt.get(account.accountId));
    accounts.push(
      account.driverKind === ANARLOG_KIND && anarlog.detection !== "found"
        ? {
            ...wire,
            // Reporting `connected` here would promise a store that is not
            // there, and the next sync would fail for a reason the panel never
            // showed. `error`, not `revoked`: putting the store back fixes it.
            status: "error",
            detail:
              anarlog.detection === "unsupportedSchema"
                ? `The store is schema v${String(anarlog.schemaVersion)}, newer than this build reads.`
                : "The store is no longer where it was connected from.",
          }
        : wire,
    );
  }

  const google = {
    configured: Option.isSome(clientId),
    clientIdHint: Option.isNone(clientId) ? null : googleClientIdHint(clientId.value),
  } satisfies NomiorGoogleClientState;

  return {
    accounts,
    google,
    anarlog,
    canStartLocalOAuth: deps.canStartLocalOAuth,
  } satisfies NomiorConnectorsListResult;
});

// ---------------------------------------------------------------------------
// Google client id
// ---------------------------------------------------------------------------

export const setGoogleClientId = Effect.fn("nomior.rpc.setGoogleClientId")(function* (
  clientIds: GoogleClientIdStore["Service"],
  input: { readonly clientId: string },
) {
  yield* clientIds.set(input.clientId).pipe(
    // The failure never carries the value, not even truncated.
    Effect.mapError(
      () =>
        new NomiorRequestError({
          message: "Could not save the Google client id.",
          retryable: true,
        }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectorConnectDeps {
  readonly accounts: ConnectorAccountStore["Service"];
  readonly clientIds: GoogleClientIdStore["Service"];
  readonly canStartLocalOAuth: boolean;
}

/** Slug-shaped and unique: `ConnectorAccountId` refuses anything else. */
const makeAccountId = Effect.fn("nomior.rpc.makeAccountId")(function* (kind: string) {
  const crypto = yield* Crypto.Crypto;
  const uuid = yield* crypto.randomUUIDv4;
  return ConnectorAccountId.make(`${kind}_${uuid.replaceAll("-", "").slice(0, 12)}`);
});

/**
 * Start a Google authorization and hand back the URL to open.
 *
 * The loopback listener is bound before this returns, so the client may open
 * the URL the instant it has it. Only the wait-and-exchange runs in the
 * background: the RPC must not be held open for however long the user spends
 * in a consent screen. The account row appears when the redirect lands, which
 * is why the panel re-lists after the browser comes back.
 */
export const connectConnector = Effect.fn("nomior.rpc.connectConnector")(function* (
  deps: ConnectorConnectDeps,
  input: { readonly kind: NomiorConnectorKind },
) {
  // Anarlog is not signed into: the store is on this machine or it is not.
  // Connecting it records the detected path as an account so a sync has
  // something to run against — without this the store is detected forever and
  // never ingested.
  if (input.kind === "anarlog") {
    // Same resolution `listConnectors` uses, so the panel can never show a
    // store at one path and connect a different one: an existing account's
    // configured path wins, otherwise the platform's default locations.
    const existing = yield* deps.accounts
      .listByDriver(ANARLOG_KIND)
      .pipe(Effect.mapError(failed("Could not read the Anarlog account.", true)));
    const state = yield* detectAnarlogState({
      overridePath: existing[0] === undefined ? undefined : readStorePath(existing[0].config),
    }).pipe(Effect.mapError(failed("Could not look for the Anarlog store.", true)));
    if (state.detection === "unsupportedSchema") {
      return yield* refuse(
        `The Anarlog store on this machine is schema v${String(state.schemaVersion)}, newer than this build reads. Update Nomior Code rather than risk misreading it.`,
      );
    }
    if (state.detection !== "found" || state.storePath === null) {
      return yield* refuse(
        "No Anarlog store on this machine. Install Anarlog and record a meeting, then connect again.",
      );
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const accountId =
      existing[0]?.accountId ??
      (yield* makeAccountId(input.kind).pipe(
        Effect.mapError(failed("Could not record the Anarlog store.", true)),
      ));
    yield* deps.accounts
      .upsert({
        accountId,
        driverKind: ANARLOG_KIND,
        displayName: state.storePath,
        config: { storePath: state.storePath },
        status: "connected",
        createdAt: now,
        updatedAt: now,
      })
      .pipe(Effect.mapError(failed("Could not record the Anarlog store.", true)));
    return { authorizationUrl: null };
  }
  if (!deps.canStartLocalOAuth) {
    return yield* refuse(
      "Google sign-in redirects to a listener on the server's own machine, so it has to be started from a client running there.",
    );
  }

  const stored = yield* deps.clientIds.get.pipe(
    Effect.mapError(failed("The Google client id is unreadable.", true)),
  );
  if (Option.isNone(stored)) {
    return yield* refuse("Set a Google OAuth client id before connecting an account.");
  }
  const clientId = stored.value;
  const accountId = yield* makeAccountId(input.kind).pipe(
    Effect.mapError(failed("Could not start Google authorization.", true)),
  );

  // The listener outlives this request, so it gets a scope of its own, closed
  // by the background fiber that owns the rest of the flow.
  const scope = yield* Scope.make();
  const handle = yield* beginGoogleLoopbackAuthorization({
    clientId,
    scopes: googleScopes(input.kind),
  }).pipe(
    Scope.provide(scope),
    Effect.tapCause(() => Scope.close(scope, Exit.void)),
    Effect.mapError(failed("Could not start Google authorization.", true)),
  );

  const driverKind = ConnectorDriverKind.make(input.kind);
  yield* Effect.gen(function* () {
    yield* completeGoogleLoopbackAuthorization({ accountId, clientId, handle });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* deps.accounts.upsert({
      accountId,
      driverKind,
      // Naming the account after its address would need a profile read the
      // Calendar port does not expose; the panel falls back to the id.
      displayName: null,
      config: {},
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
  }).pipe(
    Effect.onExit((exit) => Scope.close(scope, exit)),
    // Nobody is waiting: the RPC answered with the URL already, so a failure
    // here can only be seen in the log and in the account that never appears.
    Effect.ignoreCause({ log: true }),
    Effect.forkDetach,
  );

  return { authorizationUrl: handle.authorizationUrl };
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

export interface ConnectorDisconnectDeps {
  readonly accounts: ConnectorAccountStore["Service"];
  readonly cursors: ConnectorCursorStore["Service"];
  readonly syncRuns: ConnectorSyncRunStore["Service"];
  readonly vault: GoogleTokenVault["Service"];
}

/**
 * Forget an account: credentials first, then the state that only makes sense
 * with them. Credentials lead deliberately — if the vault write fails the call
 * fails with the account still listed, which is recoverable, rather than
 * leaving a token behind that nothing references any more.
 */
export const disconnectConnector = Effect.fn("nomior.rpc.disconnectConnector")(function* (
  deps: ConnectorDisconnectDeps,
  input: { readonly accountId: string },
) {
  const accountId = ConnectorAccountId.make(input.accountId);
  const account = yield* deps.accounts
    .get(accountId)
    .pipe(Effect.mapError(failed("Connectors are unavailable.", true)));
  if (Option.isNone(account)) {
    return yield* refuse(`No connected account with id ${input.accountId}.`);
  }

  yield* deps.vault
    .remove(accountId)
    .pipe(Effect.mapError(failed("Could not remove the stored credentials.", true)));
  yield* deps.cursors
    .clearAccount(accountId)
    .pipe(Effect.mapError(failed("Could not clear the account's sync state.", true)));
  yield* deps.syncRuns
    .remove(accountId)
    .pipe(Effect.mapError(failed("Could not clear the account's sync state.", true)));
  yield* deps.accounts
    .remove(accountId)
    .pipe(Effect.mapError(failed("Could not remove the account.", true)));
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface ConnectorSyncDeps {
  readonly accounts: ConnectorAccountStore["Service"];
  readonly clientIds: GoogleClientIdStore["Service"];
}

/**
 * Ingest whatever one account has for us right now.
 *
 * The Google ports are built per call rather than at layer time because they
 * need the operator's client id, which is a value in a store and can be unset
 * — a layer that failed on an unset id would take the whole websocket
 * connection down on first run.
 */
export const syncConnector = Effect.fn("nomior.rpc.syncConnector")(function* (
  deps: ConnectorSyncDeps,
  input: { readonly accountId: string },
) {
  const accountId = ConnectorAccountId.make(input.accountId);
  const account = yield* deps.accounts
    .get(accountId)
    .pipe(Effect.mapError(failed("Connectors are unavailable.", true)));
  if (Option.isNone(account)) {
    return yield* refuse(`No connected account with id ${input.accountId}.`);
  }

  const clientId = yield* deps.clientIds.get.pipe(
    Effect.mapError(failed("The Google client id is unreadable.", true)),
  );
  const isGoogle = account.value.driverKind !== ANARLOG_KIND;
  if (isGoogle && Option.isNone(clientId)) {
    return yield* refuse("Set a Google OAuth client id before syncing a Google account.");
  }

  const googlePorts = Layer.mergeAll(GoogleCalendarPortLive, GmailPortLive).pipe(
    Layer.provide(
      Layer.succeed(
        GoogleClientConfig,
        // Empty only on the Anarlog path, which never reads it.
        GoogleClientConfig.of({ clientId: Option.getOrElse(clientId, () => "") }),
      ),
    ),
  );

  const result = yield* runConnectorSync(account.value).pipe(
    Effect.provide(googlePorts),
    Effect.mapError(failedByTag("The sync could not be completed.")),
  );
  return { ingested: result.ingested } satisfies NomiorConnectorSyncResult;
});
