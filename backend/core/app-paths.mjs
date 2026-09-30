import { mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { readXdgUserDirs } from "./xdg-user-dirs.mjs";

/**
 * Where application data lives. Environment, platform and home are read at call
 * time (tests and Host change them), and every helper that has a platform- or
 * environment-specific branch accepts injected values.
 *
 * Tests once resolved the live %APPDATA% directory and a read-modify-write cycle
 * replaced the user's real store, so refuse anything outside the temp directory
 * while NODE_ENV is "test" instead of trusting every test to override the env.
 */
function assertTestSafe(directory) {
  if (process.env.NODE_ENV !== "test") return directory;
  if (sameOrDescendantPath(directory, tmpdir())) return directory;
  throw new Error(
    `Refusing to use the live LeafCodePi directory ${directory} during tests. Point LEAFCODE_PI_DATA_DIR / LEAFCODE_PI_DEFAULT_DIR at a temp directory, or mock every path helper the code under test uses.`,
  );
}

export function dataDir() {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return assertTestSafe(override);
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return assertTestSafe(join(roaming, "leafcode-pi"));
  }
  return assertTestSafe(join(homedir(), ".leafcode-pi"));
}

export function storePath() {
  return join(dataDir(), "store.json");
}

export function webUiAuthConfigPath() {
  return join(dataDir(), "webui-auth.json");
}

/**
 * User-facing data-dir path. Uses the familiar env/tilde form for defaults so
 * Linux users are not shown a Windows %APPDATA% location.
 */
export function displayLeafcodePiDataPath(
  relative = "",
  platform = process.platform,
  dataDirOverride = process.env.LEAFCODE_PI_DATA_DIR,
) {
  const override = dataDirOverride?.trim();
  const separator = platform === "win32" ? "\\" : "/";
  const rel = relative.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  if (override) {
    const root = override.replace(/[\\/]+$/, "");
    return rel ? `${root}${separator}${rel}` : root;
  }
  const root = platform === "win32" ? "%APPDATA%\\leafcode-pi" : "~/.leafcode-pi";
  return rel ? `${root}${separator}${rel}` : root;
}

export function pathKey(value, platform = process.platform) {
  const path = platform === "win32" ? win32.resolve(value) : posix.resolve(value);
  return platform === "win32" ? path.toLowerCase() : path;
}

export function samePath(left, right, platform = process.platform) {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function sameOrDescendantPath(value, parent, platform = process.platform) {
  const path = pathKey(value, platform);
  const root = pathKey(parent, platform);
  const separator = platform === "win32" ? win32.sep : posix.sep;
  return path === root || path.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

/** Base directory for tasks started without a registered project. */
export function resolveNoProjectRoot(options) {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? homedir();
  const exists = options?.exists ?? existsSync;
  const override = env.LEAFCODE_PI_DEFAULT_DIR?.trim();
  if (override) return resolve(override);
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  const documentCandidates = platform === "win32"
    ? [pathJoin(home, "Documents")]
    : [readXdgUserDirs({ home, env }).documents, pathJoin(home, "Documents")].filter(Boolean);
  const documents = documentCandidates.find((path) => exists(path));
  if (documents) return pathJoin(documents, "LeafCodePi");
  if (platform === "win32") return pathJoin(home, "LeafCodePi");
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return pathJoin(xdg, "LeafCodePi");
  return pathJoin(home, ".local", "share", "LeafCodePi");
}

/** Base directory for tasks started without a registered project. */
export function noProjectRoot() {
  return assertTestSafe(resolveNoProjectRoot());
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function noProjectSessionName(date, withSeconds = false) {
  const minute = `${twoDigits(date.getFullYear() % 100)}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}_${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}`;
  return withSeconds ? `${minute}${twoDigits(date.getSeconds())}` : minute;
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

/** Create an isolated workspace, adding seconds only when the minute name collides. */
export function noProjectSessionDir(date = new Date()) {
  const root = noProjectRoot();
  mkdirSync(root, { recursive: true });
  const minuteName = noProjectSessionName(date);
  const candidates = [minuteName, noProjectSessionName(date, true)];
  for (const name of candidates) {
    const directory = join(/* turbopackIgnore: true */ root, name);
    try {
      mkdirSync(directory);
      return directory;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
  for (let index = 1; ; index += 1) {
    const directory = join(/* turbopackIgnore: true */ root, `${candidates[1]}_${index}`);
    try {
      mkdirSync(directory);
      return directory;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
}

export function isAbsolutePath(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\");
}
