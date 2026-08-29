// @effect-diagnostics preferSchemaOverJson:off - asserts the raw persisted JSON bytes.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../../auth/ServerSecretStore.ts";
import { ConnectorAccountId } from "../Records.ts";
import type { GoogleTokenSet } from "./GooglePorts.ts";
import { GoogleTokenVaultError, make } from "./GoogleTokenVault.ts";

const accountA = ConnectorAccountId.make("google_work");
const accountB = ConnectorAccountId.make("google_personal");

const tokens = (marker: string): GoogleTokenSet => ({
  accessToken: `access-${marker}`,
  refreshToken: `refresh-${marker}`,
  expiryMs: 1787565600000,
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
});

/** In-memory ServerSecretStore over the same bytes contract as the real one. */
const makeSecretStoreFake = () => {
  const secrets = new Map<string, Uint8Array>();
  return {
    secrets,
    layer: Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
        set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        getOrCreateRandom: (name) => Effect.sync(() => secrets.get(name) ?? new Uint8Array(0)),
        remove: (name) => Effect.sync(() => void secrets.delete(name)),
      }),
    ),
  };
};

it.effect("round-trips a token set through secret-store bytes", () =>
  Effect.gen(function* () {
    const fake = makeSecretStoreFake();
    const vault = yield* make.pipe(Effect.provide(fake.layer));

    assert.deepEqual(yield* vault.get(accountA), Option.none());

    yield* vault.set(accountA, tokens("a"));
    // Stored as encoded JSON bytes under a per-account secret name.
    const names = [...fake.secrets.keys()];
    assert.deepEqual(names, [`nomior-google-token-${accountA}`]);
    const persisted = fake.secrets.get(names[0] ?? "");
    assert.isDefined(persisted);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(persisted)), {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiryMs: 1787565600000,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    assert.deepEqual(yield* vault.get(accountA), Option.some(tokens("a")));

    yield* vault.remove(accountA);
    assert.deepEqual(yield* vault.get(accountA), Option.none());
    assert.strictEqual(fake.secrets.size, 0);
  }),
);

it.effect("isolates accounts under distinct secret names", () =>
  Effect.gen(function* () {
    const fake = makeSecretStoreFake();
    const vault = yield* make.pipe(Effect.provide(fake.layer));

    yield* vault.set(accountA, tokens("a"));
    yield* vault.set(accountB, tokens("b"));
    assert.strictEqual(fake.secrets.size, 2);

    yield* vault.remove(accountA);
    assert.deepEqual(yield* vault.get(accountA), Option.none());
    assert.deepEqual(yield* vault.get(accountB), Option.some(tokens("b")));
  }),
);

it.effect("fails loudly (not silently empty) on undecodable stored bytes", () =>
  Effect.gen(function* () {
    const fake = makeSecretStoreFake();
    const vault = yield* make.pipe(Effect.provide(fake.layer));

    fake.secrets.set(`nomior-google-token-${accountA}`, new TextEncoder().encode("not json"));
    const failure = yield* vault.get(accountA).pipe(Effect.flip);
    assert.instanceOf(failure, GoogleTokenVaultError);
    assert.strictEqual(failure.operation, "get");
  }),
);
