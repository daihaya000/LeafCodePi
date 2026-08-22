import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { listProjects } from "@/lib/store";

/** Roots the directory browser may enumerate (home + registered projects). */
export function browseAllowedRoots(): string[] {
  const roots = new Set<string>([resolve(homedir())]);
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
