import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hard-link mirror of `web/`, used as the Next.js project root for production
 * builds. Ported from LeafCode (scripts/web-build-mirror.mjs).
 *
 * Why a mirror at all: this repository lives inside a OneDrive-synced folder,
 * and letting the sync client touch a build that is being written (or served)
 * mixes chunk generations. Both failures observed here came from that —
 * `Cannot find module './chunks/vendor-chunks/next.js'` and a `.next` that had
 * a prod `webpack-runtime.js` without the chunks it referenced. Next 16 also
 * refuses a distDir that navigates out of the project ("Invalid distDirRoot"),
 * so moving only the output is not an option: the project itself has to sit
 * outside the synced tree.
 *
 * Why hard links: a byte copy of `node_modules/` is hundreds of MB. Hard links
 * cost no additional disk and mirror in seconds. Junctions and symlinks do not
 * work — bundlers canonicalize reparse points, so every module resolves back to
 * its OneDrive path. Hard links are not reparse points, so the mirror looks like
 * plain files. Cross-volume mirrors cannot be hard-linked and fall back to a
 * byte copy.
 *
 * Hazard: a hard link shares its contents with the source, so anything the
 * build writes in place would also rewrite the repository's file. Only ignored
 * dependencies under `node_modules/` are linked. Repository-owned files are
 * copied so build tooling can mutate them (hard-linked files are rejected at
 * nlink > 1).
 *
 * Unlike LeafCode this mirrors only `web/`, not the whole installation:
 * next.config.ts here imports nothing above `web/` and pins
 * outputFileTracingRoot to `web/`, so the build is self-contained.
 */

const HERE = fileURLToPath(import.meta.url);
const DEFAULT_WEB_DIR = resolve(HERE, "..", "..", "web");

/** Never mirrored: VCS metadata and build outputs. */
const SKIP_DIRS = new Set([".git", ".next"]);

const SKIP_FILES = new Set(["tsconfig.tsbuildinfo"]);

/** Ignored dependencies are the only files safe to share with the mirror. */
const LINK_PREFIXES = ["node_modules"];

/** Stable per-checkout mirror name, so two checkouts never share one. */
export function mirrorSlug(sourceDir) {
  const normalized = resolve(sourceDir).replaceAll("/", "\\").toLowerCase();
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  // Both halves come from the normalized path: deriving the readable part from
  // the raw argument would give one checkout two mirrors depending on the
  // casing the caller happened to use.
  return `${basename(dirname(normalized)) || "install"}-${digest}`;
}

/**
 * Mirror root for a checkout — this is the Next.js project root for the build.
 * Priority: LEAFCODE_PI_BUILD_DIR → %LOCALAPPDATA%\leafcode-pi\build\<slug>
 * → %APPDATA%\... → <webDir>\.build-mirror (last resort, e.g. no env at all).
 */
export function resolveMirrorRoot(env = process.env, sourceDir = DEFAULT_WEB_DIR) {
  const explicit = env.LEAFCODE_PI_BUILD_DIR?.trim();
  if (explicit) return resolve(explicit);

  const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (base) return join(base, "leafcode-pi", "build", mirrorSlug(sourceDir));

  return join(resolve(sourceDir), ".build-mirror");
}

/** Production build output, always inside the mirrored project (Turbopack). */
export function mirrorDistDir(mirrorRoot) {
  return join(mirrorRoot, ".next");
}

function shouldCopy(relPath) {
  const normalized = relPath.replaceAll("/", sep);
  const parts = normalized.split(sep).filter(Boolean);
  return parts.length === 0 || !LINK_PREFIXES.includes(parts[0]);
}

/** Re-place a linked repository file with an independent copy after policy changes. */
function needsReplace(sourceStat, targetStat, relPath, from, to) {
  if (!targetStat) return true;
  if (!isUpToDate(sourceStat, targetStat, relPath, from, to)) return true;
  return shouldCopy(relPath) && sourceStat.nlink > 1;
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
  return existsSync(join(mirrorRoot, "node_modules", "next", "dist", "compiled", "commander", "index.js"));
}

/** Same content already in place? Synced files can keep size/mtime after their bytes change. */
function isUpToDate(sourceStat, targetStat, relPath, from, to) {
  if (targetStat.size !== sourceStat.size || Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) >= 2) {
    return false;
  }
  if (!shouldCopy(relPath)) return true;
  try {
    return readFileSync(from).equals(readFileSync(to));
  } catch {
    return false;
  }
}

function placeFile(from, to, relPath, stats) {
  if (shouldCopy(relPath)) {
    copyFileSync(from, to);
    utimesSync(to, stats.atime, stats.mtime);
    return "copied";
  }
  try {
    linkSync(from, to);
    return "linked";
  } catch (err) {
    // EXDEV: mirror is on another volume. EPERM/EACCES: filesystem refuses
    // hard links. Either way a byte copy still produces a correct mirror.
    if (err.code !== "EXDEV" && err.code !== "EPERM" && err.code !== "EACCES") throw err;
    copyFileSync(from, to);
    utimesSync(to, stats.atime, stats.mtime);
    return "copied";
  }
}

function syncDir(sourceDir, targetDir, rootDir, counters) {
  mkdirSync(targetDir, { recursive: true });

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true });
  const keep = new Set();

  for (const entry of sourceEntries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    // Name-based: OneDrive cloud files report Dirent.isFile() === false.
    if (!entry.isDirectory() && SKIP_FILES.has(entry.name)) continue;

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
      syncDir(from, to, rootDir, counters);
      continue;
    }

    const relPath = relative(rootDir, from);
    const sourceStat = statSync(from);
    let targetStat;
    try {
      targetStat = statSync(to);
    } catch {
      targetStat = undefined;
    }
    if (targetStat && !needsReplace(sourceStat, targetStat, relPath, from, to)) {
      counters.unchanged += 1;
      continue;
    }
    if (targetStat) unlinkSync(to);
    counters[placeFile(from, to, relPath, sourceStat)] += 1;
  }

  // Prune what the source no longer has. The build output lives in the
  // mirror's `.next`, which the source never contains, so the SKIP_DIRS check
  // above preserves it.
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
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

  if (mirrorRoot === sourceDir || mirrorRoot.startsWith(sourceDir + sep)) {
    throw new Error(`The build mirror (${mirrorRoot}) must not live inside the project (${sourceDir}).`);
  }

  const counters = { linked: 0, copied: 0, unchanged: 0, removed: 0 };
  const startedAt = Date.now();
  syncDir(sourceDir, mirrorRoot, sourceDir, counters);

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
      `[web-build-mirror] ${result.mirrorRoot} (linked ${result.linked}, copied ${result.copied}, unchanged ${result.unchanged}, removed ${result.removed}, ${result.durationMs}ms)`,
    );
    console.log(result.mirrorRoot);
  }
}
