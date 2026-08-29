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
import { bundledGoogleClientId } from "../connectors/google/bundledClientId.ts";
import type { GoogleTokenVault } from "../connectors/google/GoogleTokenVault.ts";
import { GmailPort, GoogleCalendarPort } from "../connectors/google/GooglePorts.ts";
import {
  GmailPortLive,
  GoogleCalendarPortLive,
  GoogleClientConfig,
} from "../connectors/google/googleapisRuntime.ts";

/**
 * The Google ports, built for one call rather than at layer time.
 *
 * The client id they need is a value in a store and can be unset, and a layer
 * that failed on an unset id would take the whole websocket connection down on
 * first run, so an unset id builds ports that fail per call instead.
 */
const googlePortsFor = (clientId: string | null) =>
  Layer.mergeAll(GoogleCalendarPortLive, GmailPortLive).pipe(
    Layer.provide(
      Layer.succeed(GoogleClientConfig, GoogleClientConfig.of({ clientId: clientId ?? "" })),
    ),
  );

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
  // A source whose schema is outside the tested range. That needs a newer
  // connector, not another attempt.
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
const WIRE_KINDS: ReadonlySet<string> = new Set(["googleCalendar", "gmail"]);

const isWireKind = (driverKind: string): driverKind is NomiorConnectorKind =>
  WIRE_KINDS.has(driverKind);

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
    accounts.push(toWireAccount(account, account.driverKind, lastSyncedAt.get(account.accountId)));
  }

  // An operator-set id wins over the bundled one: pointing an environment at
  // your own Google Cloud project is the whole reason to set it.
  const effectiveClientId = Option.isSome(clientId) ? clientId.value : bundledGoogleClientId;
  const google = {
    configured: effectiveClientId !== null,
    source: Option.isSome(clientId)
      ? "operator"
      : bundledGoogleClientId === null
        ? "none"
        : "bundled",
    clientIdHint: effectiveClientId === null ? null : googleClientIdHint(effectiveClientId),
  } satisfies NomiorGoogleClientState;

  return {
    accounts,
    google,
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

/**
 * The address a freshly authorized account signs in as, or null.
 *
 * Two accounts on one machine are the ordinary case now, so a list of opaque
 * ids is not a list anybody can use — the calendar legend and the connectors
 * page both label an account with whatever this returns. Neither read costs a
 * scope beyond the one just consented to. Null is a legitimate answer: an
 * account with a name is nicer, but not at the price of a connect that fails
 * after the user has already granted it.
 */
const googleAddress = Effect.fn("nomior.rpc.googleAddress")(function* (
  accountId: ConnectorAccountId,
  kind: "googleCalendar" | "gmail",
  clientId: string,
) {
  const address = yield* Effect.gen(function* () {
    if (kind === "googleCalendar") {
      const calendar = yield* GoogleCalendarPort;
      return yield* calendar.primaryAddress({ accountId });
    }
    const gmail = yield* GmailPort;
    return (yield* gmail.getProfile({ accountId })).emailAddress;
  }).pipe(
    Effect.provide(googlePortsFor(clientId)),
    Effect.orElseSucceed(() => ""),
  );
  return address.length === 0 ? null : address;
});

/**
 * The sync a freshly connected account runs on its own.
 *
 * Connecting and then having nothing to show until the user finds the Sync
 * button is the whole setup cost of this page, so the first run is not asked
 * for. Its failure is not the connect's failure: an account that is connected
 * but unsynced is recoverable from the Sync button beside it, where refusing
 * the connect would throw away a credential the user just granted.
 *
 * The call site is already inside the fiber that waits for the redirect, so
 * this stays inline: it runs in the background the connect was already in.
 */
const firstSync = (account: ConnectorAccount, clientId: string | null) =>
  runConnectorSync(account).pipe(
    Effect.provide(googlePortsFor(clientId)),
    Effect.ignoreCause({ log: true }),
  );

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
  if (!deps.canStartLocalOAuth) {
    return yield* refuse(
      "Google sign-in redirects to a listener on the server's own machine, so it has to be started from a client running there.",
    );
  }

  const stored = yield* deps.clientIds.get.pipe(
    Effect.mapError(failed("The Google client id is unreadable.", true)),
  );
  const clientId = Option.isSome(stored) ? stored.value : bundledGoogleClientId;
  if (clientId === null) {
    return yield* refuse(
      "This build ships no Google client id. Add one under Advanced to connect an account.",
    );
  }
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

  // Bound out here so the closure below keeps the narrowed kind.
  const googleKind = input.kind;
  const driverKind = ConnectorDriverKind.make(googleKind);
  yield* Effect.gen(function* () {
    const account = yield* Effect.gen(function* () {
      yield* completeGoogleLoopbackAuthorization({ accountId, clientId, handle });
      const now = DateTime.formatIso(yield* DateTime.now);
      const account: ConnectorAccount = {
        accountId,
        driverKind,
        displayName: yield* googleAddress(accountId, googleKind, clientId),
        config: {},
        status: "connected",
        createdAt: now,
        updatedAt: now,
      };
      yield* deps.accounts.upsert(account);
      return account;
      // The loopback listener is done the moment the redirect is exchanged, so
      // it is closed here rather than held open for the sync that follows.
    }).pipe(Effect.onExit((exit) => Scope.close(scope, exit)));

    yield* firstSync(account, clientId);
  }).pipe(
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
  const effectiveClientId = Option.isSome(clientId) ? clientId.value : bundledGoogleClientId;
  if (effectiveClientId === null) {
    return yield* refuse("Set a Google OAuth client id before syncing a Google account.");
  }

  const result = yield* runConnectorSync(account.value).pipe(
    Effect.provide(googlePortsFor(effectiveClientId)),
    Effect.mapError(failedByTag("The sync could not be completed.")),
  );
  return { ingested: result.ingested } satisfies NomiorConnectorSyncResult;
});
