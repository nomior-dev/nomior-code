/**
 * Locate the Anarlog desktop app's local store on this machine.
 *
 * Path resolution mirrors anarlog's own (`crates/storage/src/global.rs` +
 * `apps/desktop/src-tauri/src/db.rs`, verified 2026-08-29): the store is
 * `<data dir>/<app folder>/app.db` where the app folder is `anarlog` for
 * current releases, `hyprnote` for pre-rename installs, and the raw bundle
 * identifier (`com.hyprnote.stable` / `com.hyprnote.dev`) for older or dev
 * builds. A settings override always wins.
 *
 * @module nomior/connectors/anarlog/AnarlogLocator
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../../../pathExpansion.ts";

const STORE_FILENAME = "app.db";

const APP_FOLDER_CANDIDATES = [
  "anarlog",
  "hyprnote",
  "com.hyprnote.stable",
  "com.hyprnote.dev",
] as const;

/** Platform equivalents of Rust `dirs::data_dir()`, best-effort. */
const dataDirCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin":
      return ["~/Library/Application Support"];
    case "win32": {
      const appData = env["APPDATA"];
      return appData === undefined ? [] : [appData];
    }
    default: {
      const xdgDataHome = env["XDG_DATA_HOME"];
      return xdgDataHome === undefined ? ["~/.local/share"] : [xdgDataHome, "~/.local/share"];
    }
  }
};

export const anarlogStoreCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> =>
  dataDirCandidates(platform, env).flatMap((dataDir) =>
    APP_FOLDER_CANDIDATES.map((folder) => `${dataDir}/${folder}/${STORE_FILENAME}`),
  );

/**
 * Resolve the store path: the override when configured (present or not, so
 * a misconfigured override surfaces as "store missing" rather than silently
 * scanning defaults), otherwise the first default candidate that exists.
 */
export const locateAnarlogStore = Effect.fnUntraced(function* (input: {
  readonly overridePath: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.overridePath !== undefined) {
    return Option.some(path.normalize(expandHomePath(input.overridePath)));
  }

  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  for (const candidate of anarlogStoreCandidates(platform, env)) {
    const resolved = path.normalize(expandHomePath(candidate));
    const exists = yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return Option.some(resolved);
    }
  }
  return Option.none<string>();
});
