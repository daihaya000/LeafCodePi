import {
  existsSync as defaultExistsSync,
  readdirSync as defaultReaddirSync,
  statSync as defaultStatSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Source roots and config files that invalidate a production `.next` build. */
const WATCHED_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "postcss.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "middleware.ts",
  "middleware.js",
];

const WATCHED_DIRS = ["src", "public"];

const WATCHED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".json",
  ".mdx",
  ".svg",
]);

/**
 * Decide how the tray host should launch the Next.js WebUI.
 * @param {string | undefined} mode
 * @param {boolean} hasBuild
 * @param {boolean} [buildStale=false]
 */
export function getWebLaunchPlan(mode, hasBuild, buildStale = false) {
  const explicitProd = mode === "prod";
  const explicitDev = mode === "dev";
  const useProd = explicitProd || (!explicitDev && hasBuild);
  return {
    needsBuild: useProd && (!hasBuild || Boolean(buildStale)),
    useProd,
  };
}

/**
 * Plan after a rebuild attempt. A freshly built tree must never be rejected
 * just because a source file changed while the build ran.
 * @param {string | undefined} mode
 * @param {boolean} hasBuild
 * @param {boolean} [buildStale=false]
 */
export function getPostBuildLaunchPlan(mode, hasBuild, buildStale = false) {
  const { needsBuild, useProd } = getWebLaunchPlan(mode, hasBuild, false);
  return {
    needsBuild,
    useProd,
    staleAfterBuild: Boolean(hasBuild && buildStale),
  };
}

/**
 * True when a production BUILD_ID exists but watched sources are newer.
 * Missing BUILD_ID is not "stale" — callers treat absence via hasBuild.
 * @param {string} webDir
 * @param {string} distDir
 * @param {{
 *   existsSync?: (path: string) => boolean,
 *   statSync?: (path: string) => { isDirectory(): boolean, isFile(): boolean, mtimeMs: number },
 *   readdirSync?: (path: string) => string[],
 * }} [fsApi]
 */
export function isWebBuildStale(webDir, distDir, fsApi = {}) {
  const existsSync = fsApi.existsSync ?? defaultExistsSync;
  const statSync = fsApi.statSync ?? defaultStatSync;
  const readdirSync = fsApi.readdirSync ?? defaultReaddirSync;

  const buildIdPath = join(distDir, "BUILD_ID");
  if (!existsSync(buildIdPath)) return false;

  let buildMtimeMs;
  try {
    buildMtimeMs = statSync(buildIdPath).mtimeMs;
  } catch {
    return false;
  }

  for (const name of WATCHED_ROOT_FILES) {
    const path = join(webDir, name);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).mtimeMs > buildMtimeMs) return true;
    } catch {
      /* ignore */
    }
  }

  for (const dirName of WATCHED_DIRS) {
    const root = join(webDir, dirName);
    if (!existsSync(root)) continue;
    if (hasNewerFile(root, buildMtimeMs, distDir, { existsSync, statSync, readdirSync })) {
      return true;
    }
  }

  return false;
}

function hasNewerFile(dir, buildMtimeMs, distDir, fsApi) {
  let entries;
  try {
    entries = fsApi.readdirSync(dir);
  } catch {
    return false;
  }

  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (resolve(path) === resolve(distDir)) continue;
    let st;
    try {
      st = fsApi.statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (hasNewerFile(path, buildMtimeMs, distDir, fsApi)) return true;
      continue;
    }
    if (!st.isFile()) continue;
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = name.slice(dot).toLowerCase();
    if (!WATCHED_EXTENSIONS.has(ext)) continue;
    if (st.mtimeMs > buildMtimeMs) return true;
  }
  return false;
}

export function formatWebStatus({ building, running, httpUp }) {
  if (building) return "LeafCodePi: building...";
  if (running && httpUp) return "LeafCodePi: running";
  if (running) return "LeafCodePi: starting...";
  return "LeafCodePi: stopped";
}

export function procRunning(proc) {
  return proc != null && proc.exitCode == null && !proc.killed;
}
