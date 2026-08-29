import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ConnectorAccountStore from "./ConnectorAccountStore.ts";
import * as ConnectorCursorStore from "./ConnectorCursorStore.ts";
import { ConnectorAccountId, ConnectorDriverKind } from "./Records.ts";

const storesLayer = Layer.mergeAll(ConnectorAccountStore.layer, ConnectorCursorStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const gmailKind = ConnectorDriverKind.make("gmail");
const accountA = ConnectorAccountId.make("gmail_work");
const accountB = ConnectorAccountId.make("gmail_personal");

const makeAccount = (
  accountId: ConnectorAccountId,
  config: unknown,
): ConnectorAccountStore.ConnectorAccount => ({
  accountId,
  driverKind: gmailKind,
  displayName: null,
  config,
  status: "connected",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

it.layer(storesLayer)("connector stores", (it) => {
  it.effect("keeps multiple accounts per driver as independent rows", () =>
    Effect.gen(function* () {
      const accounts = yield* ConnectorAccountStore.ConnectorAccountStore;
      yield* accounts.upsert(makeAccount(accountA, { labels: ["team"] }));
      yield* accounts.upsert(makeAccount(accountB, { labels: ["family"] }));

      const byDriver = yield* accounts.listByDriver(gmailKind);
      assert.deepEqual(
        byDriver.map((account) => account.accountId),
        [accountA, accountB],
      );

      const loadedA = yield* accounts.get(accountA);
      assert.isTrue(Option.isSome(loadedA));
      assert.deepEqual(Option.getOrThrow(loadedA).config, { labels: ["team"] });

      yield* accounts.setStatus(accountB, "error");
      const loadedB = yield* accounts.get(accountB);
      assert.strictEqual(Option.getOrThrow(loadedB).status, "error");
      // Account A is untouched by B's status change.
      const reloadedA = yield* accounts.get(accountA);
      assert.strictEqual(Option.getOrThrow(reloadedA).status, "connected");

      yield* accounts.remove(accountB);
      assert.deepEqual(
        (yield* accounts.listByDriver(gmailKind)).map((account) => account.accountId),
        [accountA],
      );
    }),
  );

  it.effect("isolates cursors per (account, stream) and clears per account", () =>
    Effect.gen(function* () {
      const cursors = yield* ConnectorCursorStore.ConnectorCursorStore;
      yield* cursors.set(accountA, "calendar:primary", "cursor-a1");
      yield* cursors.set(accountA, "gmail", "cursor-a2");
      yield* cursors.set(accountB, "gmail", "cursor-b");

      assert.deepEqual(yield* cursors.get(accountA, "calendar:primary"), Option.some("cursor-a1"));
      // B's stream of the same name is a different row.
      assert.deepEqual(yield* cursors.get(accountB, "gmail"), Option.some("cursor-b"));
      assert.deepEqual(yield* cursors.get(accountB, "calendar:primary"), Option.none());

      yield* cursors.set(accountA, "gmail", "cursor-a2-next");
      assert.deepEqual(yield* cursors.get(accountA, "gmail"), Option.some("cursor-a2-next"));

      yield* cursors.clearAccount(accountA);
      assert.deepEqual(yield* cursors.get(accountA, "gmail"), Option.none());
      assert.deepEqual(yield* cursors.get(accountA, "calendar:primary"), Option.none());
      // Clearing A never touches B.
      assert.deepEqual(yield* cursors.get(accountB, "gmail"), Option.some("cursor-b"));
    }),
  );
});
