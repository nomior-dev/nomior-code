// @effect-diagnostics nodeBuiltinImport:off - fixture dirs are built with raw node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { anarlogStoreCandidates, locateAnarlogStore } from "./AnarlogLocator.ts";

it("orders candidates per platform: anarlog first, legacy folders after", () => {
  assert.deepEqual(anarlogStoreCandidates("darwin", {}), [
    "~/Library/Application Support/anarlog/app.db",
    "~/Library/Application Support/hyprnote/app.db",
    "~/Library/Application Support/com.hyprnote.stable/app.db",
    "~/Library/Application Support/com.hyprnote.dev/app.db",
  ]);

  // Linux: explicit XDG_DATA_HOME outranks the default, both are scanned.
  assert.deepEqual(anarlogStoreCandidates("linux", { XDG_DATA_HOME: "/data" }).slice(0, 5), [
    "/data/anarlog/app.db",
    "/data/hyprnote/app.db",
    "/data/com.hyprnote.stable/app.db",
    "/data/com.hyprnote.dev/app.db",
    "~/.local/share/anarlog/app.db",
  ]);
  assert.deepEqual(anarlogStoreCandidates("linux", {})[0], "~/.local/share/anarlog/app.db");

  // Windows: APPDATA required — no APPDATA, no default candidates.
  assert.deepEqual(
    anarlogStoreCandidates("win32", { APPDATA: "C:\\AppData" })[0],
    "C:\\AppData/anarlog/app.db",
  );
  assert.deepEqual(anarlogStoreCandidates("win32", {}), []);
});

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nomior-locator-"))),
    (dir) => Effect.scoped(use(dir)),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("locateAnarlogStore", (it) => {
  it.effect("an override always wins — even when the path does not exist", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        // A real store exists in the default location, but the override
        // (pointing nowhere) is returned anyway so a misconfigured
        // override surfaces as "store missing", never a silent fallback.
        NodeFS.mkdirSync(NodePath.join(dir, "anarlog"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, "anarlog", "app.db"), "");
        const missing = NodePath.join(dir, "missing", "custom.db");

        const located = yield* locateAnarlogStore({ overridePath: missing }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, { XDG_DATA_HOME: dir }),
        );
        assert.deepEqual(located, Option.some(missing));
      }),
    ),
  );

  it.effect("without an override, picks the first existing default candidate", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        // Only the legacy "hyprnote" folder exists — it is found; with the
        // current "anarlog" folder also present, that one wins instead.
        NodeFS.mkdirSync(NodePath.join(dir, "hyprnote"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, "hyprnote", "app.db"), "");

        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessEnvironment, { XDG_DATA_HOME: dir }),
          );

        const legacy = yield* provide(locateAnarlogStore({ overridePath: undefined }));
        assert.deepEqual(legacy, Option.some(NodePath.join(dir, "hyprnote", "app.db")));

        NodeFS.mkdirSync(NodePath.join(dir, "anarlog"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, "anarlog", "app.db"), "");
        const current = yield* provide(locateAnarlogStore({ overridePath: undefined }));
        assert.deepEqual(current, Option.some(NodePath.join(dir, "anarlog", "app.db")));
      }),
    ),
  );

  it.effect("returns none when no candidate exists", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const located = yield* locateAnarlogStore({ overridePath: undefined }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, { XDG_DATA_HOME: dir }),
        );
        assert.deepEqual(located, Option.none());
      }),
    ),
  );
});
