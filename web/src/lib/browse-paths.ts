import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
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
      roots.set(path.toLowerCase(), path);
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

export function isAllowedBrowsePath(target: string): boolean {
  const resolved = resolve(target);
  const needle = resolved.toLowerCase();
  for (const root of browseAllowedRoots()) {
    const base = root.toLowerCase();
    if (needle === base) return true;
    const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
    if (needle.startsWith(prefix)) return true;
  }
  return false;
}
