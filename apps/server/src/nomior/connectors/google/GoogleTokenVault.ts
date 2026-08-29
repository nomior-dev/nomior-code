/**
 * GoogleTokenVault — per-account OAuth token storage.
 *
 * Backed by upstream's `ServerSecretStore` (0600 files under the server's
 * secrets dir — the same seam every other server secret uses; on managed
 * installs that dir lives inside the OS-protected data directory). Tokens
 * never appear in settings, the database, or logs. One secret per
 * account id, so accounts are isolated by construction.
 *
 * @module nomior/connectors/google/GoogleTokenVault
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type SecretStoreError, ServerSecretStore } from "../../../auth/ServerSecretStore.ts";
import type { ConnectorAccountId } from "../Records.ts";
import { GoogleTokenSet } from "./GooglePorts.ts";

const decodeTokenSet = Schema.decodeUnknownEffect(Schema.fromJsonString(GoogleTokenSet));
const encodeTokenSet = Schema.encodeEffect(Schema.fromJsonString(GoogleTokenSet));

export class GoogleTokenVaultError extends Schema.TaggedErrorClass<GoogleTokenVaultError>()(
  "GoogleTokenVaultError",
  {
    operation: Schema.String,
    accountId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Google token vault ${this.operation} failed for account ${this.accountId}`;
  }
}

const secretName = (accountId: ConnectorAccountId): string => `nomior-google-token-${accountId}`;

export class GoogleTokenVault extends Context.Service<
  GoogleTokenVault,
  {
    readonly get: (
      accountId: ConnectorAccountId,
    ) => Effect.Effect<Option.Option<GoogleTokenSet>, GoogleTokenVaultError>;
    readonly set: (
      accountId: ConnectorAccountId,
      tokens: GoogleTokenSet,
    ) => Effect.Effect<void, GoogleTokenVaultError>;
    readonly remove: (accountId: ConnectorAccountId) => Effect.Effect<void, GoogleTokenVaultError>;
  }
>()("t3/nomior/connectors/google/GoogleTokenVault") {}

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const wrapError =
    (operation: string, accountId: ConnectorAccountId) =>
    (cause: SecretStoreError | Schema.SchemaError): GoogleTokenVaultError =>
      new GoogleTokenVaultError({ operation, accountId, cause });

  return GoogleTokenVault.of({
    get: (accountId) =>
      secretStore.get(secretName(accountId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<GoogleTokenSet>()),
            onSome: (bytes) =>
              decodeTokenSet(new TextDecoder().decode(bytes)).pipe(Effect.map(Option.some)),
          }),
        ),
        Effect.mapError(wrapError("get", accountId)),
        Effect.withSpan("GoogleTokenVault.get"),
      ),
    set: (accountId, tokens) =>
      encodeTokenSet(tokens).pipe(
        Effect.flatMap((json) =>
          secretStore.set(secretName(accountId), new TextEncoder().encode(json)),
        ),
        Effect.mapError(wrapError("set", accountId)),
        Effect.withSpan("GoogleTokenVault.set"),
      ),
    remove: (accountId) =>
      secretStore
        .remove(secretName(accountId))
        .pipe(
          Effect.mapError(wrapError("remove", accountId)),
          Effect.withSpan("GoogleTokenVault.remove"),
        ),
  });
});

export const layer = Layer.effect(GoogleTokenVault, make);
