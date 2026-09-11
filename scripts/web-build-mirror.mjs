import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Persistent production workspace outside OneDrive, at the existing mirror path.
 * Next 16 requires distDir to stay inside its project, so copy only web sources
 * here. Dependencies are installed locally by build-web.mjs, never traversed or
 * hard-linked from OneDrive. Build output and caches stay in this workspace.
 */

const HERE = fileURLToPath(import.meta.url);
const DEFAULT_WEB_DIR = resolve(HERE, "..", "..", "web");

/** Workspace-owned directories must never be synced or pruned. */
const SKIP_DIRS = new Set([".git", ".next", ".next.prev", "node_modules", "node_modules.prev"]);

const SKIP_FILES = new Set(["tsconfig.tsbuildinfo"]);

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
 * Mirror root for a checkout — this is the Next.js project root for the build.
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

/** Production build output, always inside the mirrored project (Turbopack). */
export function mirrorDistDir(mirrorRoot) {
  return join(mirrorRoot, ".next");
}

/** Replace legacy hard links with independent source copies. */
function needsReplace(sourceStat, targetStat, from, to) {
  return !targetStat || targetStat.nlink > 1 || !isUpToDate(sourceStat, targetStat, from, to);
}

/**
 * Classify a source dirent for mirroring.
 *
 * On Windows, OneDrive cloud files are reparse points: `Dirent.isSymbolicLink()`
 * is true and `Dirent.isFile()` is false, but `lstat()` reports a regular file.
 * Skipping those leaves empty directories in the mirror (Next then fails with
 * `Cannot find module 'next/dist/compiled/commander'`). Real junctions and
 * symlinks — the ones bundlers canonicalize through — are
 * `lstat().isSymbolicLink() === true` and must stay skipped.
 *
 * @param {{ isFile(): boolean, isDirectory(): boolean, isSymbolicLink(): boolean }} dirent
 * @param {{ isFile(): boolean, isDirectory(): boolean, isSymbolicLink(): boolean } | null} lstat
 * @returns {"skip" | "dir" | "file"}
 */
export function sourceEntryKind(dirent, lstat) {
  if (dirent.isSymbolicLink() || (!dirent.isFile() && !dirent.isDirectory())) {
    if (!lstat || lstat.isSymbolicLink()) return "skip";
    if (lstat.isDirectory()) return "dir";
    if (lstat.isFile()) return "file";
    return "skip";
  }
  if (dirent.isDirectory()) return "dir";
  if (dirent.isFile()) return "file";
  return "skip";
}

/** True when the mirrored `next` CLI can boot (`commander` is the first import). */
export function isMirroredNextCliReady(mirrorRoot) {
  return existsSync(join(mirrorRoot, "node_modules", "next", "dist", "bin", "next")) &&
    existsSync(join(mirrorRoot, "node_modules", "next", "dist", "compiled", "commander", "index.js"));
}

/** Same content already in place? Synced files can keep size/mtime after their bytes change. */
function isUpToDate(sourceStat, targetStat, from, to) {
  if (targetStat.size !== sourceStat.size || Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) >= 2) {
    return false;
  }
  try {
    return readFileSync(from).equals(readFileSync(to));
  } catch {
    return false;
  }
}

function syncDir(sourceDir, targetDir, counters) {
  mkdirSync(targetDir, { recursive: true });

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true });
  const keep = new Set();

  for (const entry of sourceEntries) {
    // Name-based: OneDrive placeholders and junctions may not report a directory.
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;

    const from = join(sourceDir, entry.name);
    const to = join(targetDir, entry.name);

    let lstat = null;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      try {
        lstat = lstatSync(from);
      } catch {
        continue;
      }
    }
    const kind = sourceEntryKind(entry, lstat);
    if (kind === "skip") continue;

    keep.add(entry.name);

    if (kind === "dir") {
      syncDir(from, to, counters);
      continue;
    }

    const sourceStat = statSync(from);
    let targetStat;
    try {
      targetStat = statSync(to);
    } catch {
      targetStat = undefined;
    }
    if (!needsReplace(sourceStat, targetStat, from, to)) {
      counters.unchanged += 1;
      continue;
    }
    if (targetStat) unlinkSync(to);
    copyFileSync(from, to);
    utimesSync(to, sourceStat.atime, sourceStat.mtime);
    counters.copied += 1;
  }

  // Prune removed sources, not the workspace's dependencies, output or caches.
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    rmSync(join(targetDir, entry.name), { recursive: true, force: true });
    counters.removed += 1;
  }
}

/**
 * Bring the mirror in line with `web/` and return where things went.
 *
 * @param {{ sourceDir?: string, mirrorRoot?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function syncMirror(options = {}) {
  const sourceDir = resolve(options.sourceDir ?? DEFAULT_WEB_DIR);
  const env = options.env ?? process.env;
  const mirrorRoot = resolve(options.mirrorRoot ?? resolveMirrorRoot(env, sourceDir));

  const source = process.platform === "win32" ? sourceDir.toLowerCase() : sourceDir;
  const target = process.platform === "win32" ? mirrorRoot.toLowerCase() : mirrorRoot;
  if (target === source || target.startsWith(source + sep) || source.startsWith(target.endsWith(sep) ? target : target + sep)) {
    throw new Error(`The build mirror (${mirrorRoot}) must not live inside the project (${sourceDir}) or contain it.`);
  }

  const counters = { copied: 0, unchanged: 0, removed: 0 };
  const startedAt = Date.now();
  syncDir(sourceDir, mirrorRoot, counters);

  return {
    sourceDir,
    mirrorRoot,
    distDir: mirrorDistDir(mirrorRoot),
    durationMs: Date.now() - startedAt,
    ...counters,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  if (process.argv.includes("--path")) {
    console.log(resolveMirrorRoot());
  } else if (process.argv.includes("--dist-dir")) {
    console.log(mirrorDistDir(resolveMirrorRoot()));
  } else {
    const result = syncMirror();
    console.error(
      `[web-build-mirror] ${result.mirrorRoot} (copied ${result.copied}, unchanged ${result.unchanged}, removed ${result.removed}, ${result.durationMs}ms)`,
    );
    console.log(result.mirrorRoot);
  }
}
