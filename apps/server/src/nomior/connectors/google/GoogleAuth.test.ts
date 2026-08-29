import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ConnectorAccountId } from "../Records.ts";
import {
  buildGoogleAuthorizationUrl,
  completeGoogleLoopbackAuthorization,
  getFreshGoogleAccessToken,
  type GoogleAuthorizationHandle,
  makeGooglePkceRequest,
} from "./GoogleAuth.ts";
import { GoogleTokenPort, type GoogleTokenSet } from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

const accountId = ConnectorAccountId.make("google_work");

const makeVaultFake = (initial?: GoogleTokenSet) => {
  const store = new Map<string, GoogleTokenSet>(
    initial === undefined ? [] : [[accountId, initial]],
  );
  return {
    store,
    layer: Layer.succeed(
      GoogleTokenVault,
      GoogleTokenVault.of({
        get: (id) => Effect.sync(() => Option.fromNullishOr(store.get(id))),
        set: (id, tokens) => Effect.sync(() => void store.set(id, tokens)),
        remove: (id) => Effect.sync(() => void store.delete(id)),
      }),
    ),
  };
};

it.layer(NodeServices.layer)("GoogleAuth", (it) => {
  it.effect("PKCE challenge is the base64url SHA-256 of the verifier", () =>
    Effect.gen(function* () {
      const { verifier, challenge, state } = yield* makeGooglePkceRequest;
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier));
      assert.strictEqual(Encoding.encodeBase64Url(digest), challenge);
      assert.isAtLeast(verifier.length, 43);
      assert.isNotEmpty(state);
    }),
  );

  it.effect("authorization URL carries PKCE + offline params and no secret", () =>
    Effect.sync(() => {
      const url = new URL(
        buildGoogleAuthorizationUrl({
          clientId: "client-123.apps.googleusercontent.com",
          redirectUri: "http://127.0.0.1:43117/oauth2/callback",
          scopes: ["scope-a", "scope-b"],
          state: "state-1",
          codeChallenge: "challenge-1",
        }),
      );
      assert.strictEqual(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
      assert.strictEqual(
        url.searchParams.get("client_id"),
        "client-123.apps.googleusercontent.com",
      );
      assert.strictEqual(
        url.searchParams.get("redirect_uri"),
        "http://127.0.0.1:43117/oauth2/callback",
      );
      assert.strictEqual(url.searchParams.get("response_type"), "code");
      assert.strictEqual(url.searchParams.get("scope"), "scope-a scope-b");
      assert.strictEqual(url.searchParams.get("code_challenge"), "challenge-1");
      assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
      assert.strictEqual(url.searchParams.get("access_type"), "offline");
      // `select_account` alongside `consent`: without it Google reuses the
      // browser's current session and a second account can never be added.
      assert.strictEqual(url.searchParams.get("prompt"), "consent select_account");
      // Desktop PKCE: the client secret must never appear.
      assert.isNull(url.searchParams.get("client_secret"));
    }),
  );

  it.effect("completing the flow exchanges with the verifier and stores tokens per account", () =>
    Effect.gen(function* () {
      const vault = makeVaultFake();
      const exchanges: Array<{
        readonly clientId: string;
        readonly code: string;
        readonly codeVerifier: string;
        readonly redirectUri: string;
      }> = [];
      const issued: GoogleTokenSet = {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiryMs: 3_600_000,
        scopes: ["scope-a"],
      };
      const tokenPortLayer = Layer.succeed(
        GoogleTokenPort,
        GoogleTokenPort.of({
          exchangeAuthorizationCode: (input) =>
            Effect.sync(() => {
              exchanges.push(input);
              return issued;
            }),
          refreshAccessToken: () => Effect.succeed(issued),
          revokeToken: () => Effect.void,
        }),
      );
      const handle: GoogleAuthorizationHandle = {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
        redirectUri: "http://127.0.0.1:43117/oauth2/callback",
        codeVerifier: "verifier-1",
        awaitAuthorizationCode: Effect.succeed("code-1"),
      };

      const tokens = yield* completeGoogleLoopbackAuthorization({
        accountId,
        clientId: "client-123",
        handle,
      }).pipe(Effect.provide(Layer.mergeAll(vault.layer, tokenPortLayer)));

      assert.deepEqual(tokens, issued);
      assert.deepEqual(exchanges, [
        {
          clientId: "client-123",
          code: "code-1",
          codeVerifier: "verifier-1",
          redirectUri: "http://127.0.0.1:43117/oauth2/callback",
        },
      ]);
      assert.deepEqual(vault.store.get(accountId), issued);
    }),
  );

  it.effect("refreshes an expiring token and keeps the stored refresh token", () =>
    Effect.gen(function* () {
      const vault = makeVaultFake({
        accessToken: "stale",
        refreshToken: "refresh-keep",
        expiryMs: 1_000,
        scopes: ["scope-a"],
      });
      const tokenPortLayer = Layer.succeed(
        GoogleTokenPort,
        GoogleTokenPort.of({
          exchangeAuthorizationCode: () => Effect.die("unused"),
          // Google refresh responses omit the refresh token.
          refreshAccessToken: () =>
            Effect.succeed({ accessToken: "fresh", expiryMs: 7_200_000, scopes: ["scope-a"] }),
          revokeToken: () => Effect.void,
        }),
      );

      const accessToken = yield* getFreshGoogleAccessToken({
        accountId,
        clientId: "client-123",
      }).pipe(Effect.provide(Layer.mergeAll(vault.layer, tokenPortLayer)));

      assert.strictEqual(accessToken, "fresh");
      const stored = vault.store.get(accountId);
      assert.strictEqual(stored?.accessToken, "fresh");
      assert.strictEqual(stored?.refreshToken, "refresh-keep");
    }),
  );
});
