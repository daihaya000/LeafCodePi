import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { listProjects } from "@/lib/store";

/** OneDrive is a trusted user folder even when it is moved outside the home directory. */
export function oneDriveRoots(): string[] {
  const home = homedir();
  const candidates = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    join(home, "OneDrive"),
  ].filter((path): path is string => Boolean(path));
  const roots = new Map<string, string>();
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
      const path = resolve(candidate);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      roots.set(key, path);
    } catch {
      // An unavailable sync folder should not make browsing fail.
    }
  }
  return [...roots.values()];
}

/** Roots the directory browser may enumerate (home + OneDrive + registered projects). */
export function browseAllowedRoots(): string[] {
  const roots = new Set<string>([resolve(homedir()), ...oneDriveRoots()]);
  for (const project of listProjects(true)) {
    roots.add(resolve(project.rootPath));
  }
  return [...roots];
}

export function isAllowedBrowsePath(
  target: string,
  options: {
    platform?: string;
    roots?: readonly string[];
    realpath?: (path: string) => string;
  } = {},
): boolean {
  const pathApi = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const canonicalize = options.realpath ?? realpathSync.native;
  const within = (base: string, path: string) => {
    const child = pathApi.relative(base, path);
    return !child || (child !== ".." && !child.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(child));
  };
  // Roots are trusted; canonicalize them first (raw spelling and real path both count).
  const rawBases: string[] = [];
  const canonicalBases: string[] = [];
  for (const root of options.roots ?? browseAllowedRoots()) {
    const raw = pathApi.resolve(root);
    try {
      canonicalBases.push(canonicalize(raw));
      rawBases.push(raw);
    } catch {
      // Missing or unreadable roots cannot authorize browsing.
    }
  }
  const requested = pathApi.resolve(target);
  // Do not touch the file system for an untrusted path (e.g. \\attacker\share would
  // leak Windows credentials over SMB) until it is lexically inside an allowed root.
  if (![...rawBases, ...canonicalBases].some((base) => within(base, requested))) return false;
  let needle: string;
  try {
    needle = canonicalize(requested);
  } catch {
    return false;
  }
  // Symlinks/junctions must still resolve inside a canonical root.
  return canonicalBases.some((base) => within(base, needle));
}
