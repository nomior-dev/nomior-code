// @effect-diagnostics nodeBuiltinImport:off - The OAuth loopback callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Google OAuth for desktop: loopback redirect + PKCE, no client secret in
 * the binary (Google treats installed-app client secrets as public and the
 * PKCE `code_verifier` as the actual proof). Modeled directly on
 * upstream's T3 Connect loopback flow in `cloud/CliTokenManager.ts` — same
 * Deferred-callback HttpRouter pattern, same PKCE construction.
 *
 * @module nomior/connectors/google/GoogleAuth
 */
import type { ConnectorAccountId } from "../Records.ts";
import { type GoogleTokenSet, GoogleTokenPort } from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * Loopback ports tried in order. Google permits any loopback port for
 * installed apps, so a short fixed list keeps the redirect URI predictable
 * while surviving an occupied port.
 */
const LOOPBACK_PORT_CANDIDATES = [43117, 43118, 43119, 43120] as const;
const LOOPBACK_CALLBACK_PATH = "/oauth2/callback";
const AUTHORIZATION_CALLBACK_TIMEOUT = Duration.minutes(10);

/** Access tokens within this horizon of expiry are refreshed before use. */
const TOKEN_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(1));

export class GoogleAuthError extends Schema.TaggedErrorClass<GoogleAuthError>()("GoogleAuthError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `Google authorization ${this.operation} failed`
      : `Google authorization ${this.operation} failed: ${this.detail}`;
  }
}

export const makeGooglePkceRequest = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  const challenge = Encoding.encodeBase64Url(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
  return { verifier, challenge, state };
});

export interface BuildGoogleAuthorizationUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly codeChallenge: string;
  readonly loginHint?: string;
}

export const buildGoogleAuthorizationUrl = (input: BuildGoogleAuthorizationUrlInput): string => {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Offline access yields the refresh token the background sync loops need;
  // consent is forced so re-connecting an account re-issues one.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (input.loginHint !== undefined) {
    url.searchParams.set("login_hint", input.loginHint);
  }
  return url.toString();
};

export interface GoogleAuthorizationHandle {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  /** PKCE verifier to send with the token exchange. */
  readonly codeVerifier: string;
  /** Resolves when the browser redirect delivers the authorization code. */
  readonly awaitAuthorizationCode: Effect.Effect<string, GoogleAuthError>;
}

export interface BeginGoogleLoopbackAuthorizationInput {
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly loginHint?: string;
}

const renderCallbackCompleteHtml = (): string =>
  '<!doctype html><meta charset="utf-8"><title>Connected</title>' +
  "<p>Account connected. You can close this window and return to Nomior Code.</p>";

/**
 * Start the loopback listener and return the URL to open in the user's
 * browser. The listener lives until the surrounding scope closes; callers
 * exchange the awaited code via `completeGoogleLoopbackAuthorization`.
 */
export const beginGoogleLoopbackAuthorization = Effect.fnUntraced(function* (
  input: BeginGoogleLoopbackAuthorizationInput,
) {
  const { verifier, challenge, state } = yield* makeGooglePkceRequest.pipe(
    Effect.mapError((cause) => new GoogleAuthError({ operation: "pkce", cause })),
  );
  const callback = yield* Deferred.make<string>();

  const attemptListen = (port: number) => {
    const redirectUri = `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}`;
    const callbackRoute = HttpRouter.add(
      "GET",
      LOOPBACK_CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, redirectUri);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || code === null || code === "") {
          return HttpServerResponse.text("Invalid Google authorization callback.", {
            status: 400,
          });
        }
        yield* Deferred.succeed(callback, code);
        return HttpServerResponse.html(renderCallbackCompleteHtml());
      }),
    );
    return HttpRouter.serve(callbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
      Effect.as(redirectUri),
    );
  };

  let redirectUri: string | undefined;
  let lastCause: unknown;
  for (const port of LOOPBACK_PORT_CANDIDATES) {
    const attempt = yield* attemptListen(port).pipe(Effect.exit);
    if (attempt._tag === "Success") {
      redirectUri = attempt.value;
      break;
    }
    lastCause = attempt.cause;
  }
  if (redirectUri === undefined) {
    return yield* new GoogleAuthError({
      operation: "listen",
      detail: `no loopback port available (tried ${LOOPBACK_PORT_CANDIDATES.join(", ")})`,
      cause: lastCause,
    });
  }

  const authorizationUrl = buildGoogleAuthorizationUrl({
    clientId: input.clientId,
    redirectUri,
    scopes: input.scopes,
    state,
    codeChallenge: challenge,
    ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
  });

  return {
    authorizationUrl,
    redirectUri,
    codeVerifier: verifier,
    awaitAuthorizationCode: Deferred.await(callback).pipe(
      Effect.timeout(AUTHORIZATION_CALLBACK_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new GoogleAuthError({ operation: "awaitCallback", detail: "timed out", cause }),
        ),
      ),
    ),
  } satisfies GoogleAuthorizationHandle;
});

export interface CompleteGoogleLoopbackAuthorizationInput {
  readonly accountId: ConnectorAccountId;
  readonly clientId: string;
  readonly handle: GoogleAuthorizationHandle;
}

/**
 * Wait for the redirect, exchange the code (PKCE — no client secret), and
 * persist the token set in the vault under this account.
 */
export const completeGoogleLoopbackAuthorization = Effect.fnUntraced(function* (
  input: CompleteGoogleLoopbackAuthorizationInput,
) {
  const tokenPort = yield* GoogleTokenPort;
  const vault = yield* GoogleTokenVault;
  const code = yield* input.handle.awaitAuthorizationCode;
  const tokens = yield* tokenPort
    .exchangeAuthorizationCode({
      clientId: input.clientId,
      code,
      codeVerifier: input.handle.codeVerifier,
      redirectUri: input.handle.redirectUri,
    })
    .pipe(Effect.mapError((cause) => new GoogleAuthError({ operation: "exchange", cause })));
  yield* vault
    .set(input.accountId, tokens)
    .pipe(Effect.mapError((cause) => new GoogleAuthError({ operation: "persist", cause })));
  return tokens;
});

/**
 * Vault-backed access token with refresh-before-expiry. The live API ports
 * call this per request; refreshed sets keep the original refresh token
 * when Google omits it from the refresh response.
 */
export const getFreshGoogleAccessToken = Effect.fnUntraced(function* (input: {
  readonly accountId: ConnectorAccountId;
  readonly clientId: string;
}) {
  const vault = yield* GoogleTokenVault;
  const tokenPort = yield* GoogleTokenPort;
  const stored = yield* vault
    .get(input.accountId)
    .pipe(Effect.mapError((cause) => new GoogleAuthError({ operation: "read", cause })));
  if (Option.isNone(stored)) {
    return yield* new GoogleAuthError({
      operation: "read",
      detail: `no stored Google credentials for account ${input.accountId}`,
    });
  }
  const tokens = stored.value;
  const now = yield* Clock.currentTimeMillis;
  if (tokens.expiryMs === undefined || tokens.expiryMs - TOKEN_REFRESH_EARLY_MS > now) {
    return tokens.accessToken;
  }
  if (tokens.refreshToken === undefined) {
    return yield* new GoogleAuthError({
      operation: "refresh",
      detail: "access token expired and no refresh token is stored; reconnect the account",
    });
  }
  const refreshed = yield* tokenPort
    .refreshAccessToken({ clientId: input.clientId, refreshToken: tokens.refreshToken })
    .pipe(Effect.mapError((cause) => new GoogleAuthError({ operation: "refresh", cause })));
  const merged: GoogleTokenSet = {
    ...refreshed,
    ...(refreshed.refreshToken === undefined && tokens.refreshToken !== undefined
      ? { refreshToken: tokens.refreshToken }
      : {}),
  };
  yield* vault
    .set(input.accountId, merged)
    .pipe(Effect.mapError((cause) => new GoogleAuthError({ operation: "persist", cause })));
  return merged.accessToken;
});
