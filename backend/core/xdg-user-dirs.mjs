import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const XDG_KEY_TO_KIND = {
  XDG_DESKTOP_DIR: "desktop",
  XDG_DOCUMENTS_DIR: "documents",
  XDG_DOWNLOAD_DIR: "downloads",
  XDG_PICTURES_DIR: "pictures",
};

function expandXdgValue(raw, home) {
  const unquoted = raw.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const unescaped = unquoted.replace(/\\([0-7]{1,3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
  return unescaped.replaceAll("$HOME", home).replace(/^~(?=$|[\\/])/, home);
}

/** Parse freedesktop user-dirs.dirs (`XDG_DESKTOP_DIR="$HOME/Desktop"`). */
export function parseXdgUserDirsFile(contents, home) {
  const dirs = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(XDG_[A-Z]+_DIR)\s*=\s*(.+)$/);
    if (!match) continue;
    const kind = XDG_KEY_TO_KIND[match[1]];
    if (!kind) continue;
    const path = expandXdgValue(match[2], home).trim();
    if (path) dirs[kind] = path;
  }
  return dirs;
}

function envXdgDir(env, key, home) {
  const raw = env?.[key]?.trim();
  if (!raw) return undefined;
  const path = expandXdgValue(raw, home);
  return path || undefined;
}

/** Read XDG user dirs from env and ~/.config/user-dirs.dirs. File wins over env. */
export function readXdgUserDirs(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const dirs = {};
  for (const [key, kind] of Object.entries(XDG_KEY_TO_KIND)) {
    const fromEnv = envXdgDir(env, key, home);
    if (fromEnv) dirs[kind] = fromEnv;
  }
  const configPath = options.configPath ?? join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "user-dirs.dirs");
  try {
    const read = options.readFile ?? ((path) => (existsSync(path) ? readFileSync(path, "utf8") : ""));
    const contents = read(configPath);
    if (contents.trim()) Object.assign(dirs, parseXdgUserDirsFile(contents, home));
  } catch {
    // Missing or unreadable user-dirs.dirs is normal on some hosts.
  }
  return dirs;
}
