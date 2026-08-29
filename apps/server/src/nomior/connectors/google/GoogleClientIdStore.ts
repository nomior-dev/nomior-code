/**
 * GoogleClientIdStore — the OAuth client id this install authorizes with.
 *
 * There is no bundled client id: the operator creates an "installed app"
 * client in their own Google Cloud project and pastes the id here, so
 * `configured: false` is the normal first-run state.
 *
 * Stored in upstream's `ServerSecretStore` (0600 files under the server's
 * secrets dir), the same seam `GoogleTokenVault` uses. Not because a Google
 * installed-app client id is a secret — Google treats it as public, which is
 * why the flow is PKCE with no client secret — but because it identifies the
 * operator's Cloud project and settings.json is a frozen upstream schema with
 * no slot for it. Nothing ever puts the whole id on the wire: the panel gets
 * `clientIdHint`, the last four characters, which is enough to tell two ids
 * apart and useless if leaked.
 *
 * @module nomior/connectors/google/GoogleClientIdStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type SecretStoreError, ServerSecretStore } from "../../../auth/ServerSecretStore.ts";

const SECRET_NAME = "nomior-google-client-id";

/** Characters of the id the panel may see. Never raise this. */
const HINT_LENGTH = 4;

export class GoogleClientIdStoreError extends Schema.TaggedErrorClass<GoogleClientIdStoreError>()(
  "GoogleClientIdStoreError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Google client id ${this.operation} failed`;
  }
}

/**
 * The tail the panel renders. Shorter ids are shown whole only when they are
 * already shorter than the hint, which no real Google client id is.
 */
export const googleClientIdHint = (clientId: string): string =>
  clientId.slice(Math.max(0, clientId.length - HINT_LENGTH));

export class GoogleClientIdStore extends Context.Service<
  GoogleClientIdStore,
  {
    readonly get: Effect.Effect<Option.Option<string>, GoogleClientIdStoreError>;
    /** An empty (or blank) id clears the setting, disabling the whole flow. */
    readonly set: (clientId: string) => Effect.Effect<void, GoogleClientIdStoreError>;
  }
>()("t3/nomior/connectors/google/GoogleClientIdStore") {}

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const wrap =
    (operation: string) =>
    (cause: SecretStoreError): GoogleClientIdStoreError =>
      new GoogleClientIdStoreError({ operation, cause });

  return GoogleClientIdStore.of({
    get: secretStore.get(SECRET_NAME).pipe(
      Effect.map(
        Option.flatMap((bytes) => {
          const clientId = new TextDecoder().decode(bytes).trim();
          return clientId === "" ? Option.none<string>() : Option.some(clientId);
        }),
      ),
      Effect.mapError(wrap("read")),
      Effect.withSpan("GoogleClientIdStore.get"),
    ),
    set: (clientId) => {
      const trimmed = clientId.trim();
      return (
        trimmed === ""
          ? secretStore.remove(SECRET_NAME)
          : secretStore.set(SECRET_NAME, new TextEncoder().encode(trimmed))
      ).pipe(
        Effect.mapError(wrap(trimmed === "" ? "clear" : "write")),
        Effect.withSpan("GoogleClientIdStore.set"),
      );
    },
  });
});

export const layer = Layer.effect(GoogleClientIdStore, make);
