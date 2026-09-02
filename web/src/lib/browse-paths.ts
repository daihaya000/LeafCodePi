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
  let needle: string;
  try {
    needle = canonicalize(pathApi.resolve(target));
  } catch {
    return false;
  }
  for (const root of options.roots ?? browseAllowedRoots()) {
    try {
      const base = canonicalize(pathApi.resolve(root));
      const child = pathApi.relative(base, needle);
      if (!child) return true;
      if (child !== ".." && !child.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(child)) {
        return true;
      }
    } catch {
      // Missing or unreadable roots cannot authorize browsing.
    }
  }
  return false;
}
