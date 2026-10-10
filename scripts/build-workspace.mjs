import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../web", import.meta.url));

/** Stable per-checkout mirror name, so two checkouts never share one. */
export function mirrorSlug(sourceDir, platform = process.platform) {
  const resolved = resolve(sourceDir);
  // Windows paths are case-insensitive; POSIX paths are not. Lower-casing a
  // Linux checkout would make distinct directories share one build mirror.
  const normalized =
    platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${basename(dirname(normalized)) || "install"}-${digest}`;
}

/**
 * Mirror root for a checkout — SPA generations live in its .spa subdirectory.
 * Priority: LEAFCODE_PI_BUILD_DIR → %LOCALAPPDATA%\leafcode-pi\build\<slug>
 * → %APPDATA%\... → $XDG_CACHE_HOME/leafcode-pi/build/<slug>
 * → ~/.cache/leafcode-pi/build/<slug> (last resort).
 */
export function resolveMirrorRoot(env = process.env, sourceDir = DEFAULT_WEB_DIR) {
  const explicit = env.LEAFCODE_PI_BUILD_DIR?.trim();
  if (explicit) return resolve(explicit);

  const base =
    env.LOCALAPPDATA?.trim() ||
    env.APPDATA?.trim() ||
    env.XDG_CACHE_HOME?.trim() ||
    join(homedir(), ".cache");
  return join(base, "leafcode-pi", "build", mirrorSlug(sourceDir));
}
