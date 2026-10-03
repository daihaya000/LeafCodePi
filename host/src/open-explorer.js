import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { resolveNoProjectRoot, storePath } from "../../backend/core/app-paths.mjs";

/** Choose the OS file-manager command. Windows Explorer stays explorer.exe. */
export function explorerOpenCommand(platform, targetPath) {
  if (platform === "win32") return { command: "explorer.exe", args: [targetPath] };
  if (platform === "darwin") return { command: "open", args: [targetPath] };
  return { command: "xdg-open", args: [targetPath] };
}

export function explorerAllowedRoots(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const roots = [home];
  for (const candidate of [
    env.OneDrive,
    env.OneDriveConsumer,
    env.OneDriveCommercial,
    join(home, "OneDrive"),
  ]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    } catch {
      // Unavailable OneDrive paths do not authorize Explorer access.
    }
  }
  try {
    roots.push(options.noProjectRoot ?? resolveNoProjectRoot({ env, home }));
  } catch {
    // Continue with the independent home/project roots.
  }
  try {
    const store = JSON.parse(readFileSync(options.storeFile ?? storePath(), "utf8"));
    if (store?.version === 1 && Array.isArray(store.projects)) {
      for (const project of store.projects) {
        if (typeof project?.rootPath === "string" && project.rootPath.trim()) roots.push(project.rootPath);
      }
    }
  } catch {
    // A missing or malformed store contributes no external project roots.
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function isAllowedExplorerPath(targetPath, options = {}) {
  const pathApi = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const canonicalize = options.realpath ?? realpathSync.native;
  const rawRoots = [];
  const canonicalRoots = [];
  for (const root of options.allowedRoots ?? explorerAllowedRoots()) {
    const raw = pathApi.resolve(root);
    try {
      canonicalRoots.push(canonicalize(raw));
      rawRoots.push(raw);
    } catch {
      // Missing or unreadable roots cannot authorize access.
    }
  }
  const within = (base, path) => {
    const child = pathApi.relative(base, path);
    return !child || (child !== ".." && !child.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(child));
  };
  const requested = pathApi.resolve(targetPath);
  if (![...rawRoots, ...canonicalRoots].some((base) => within(base, requested))) return false;
  try {
    const canonicalTarget = canonicalize(requested);
    return canonicalRoots.some((base) => within(base, canonicalTarget));
  } catch {
    return false;
  }
}

export function openProjectInExplorer(targetPath, options = {}) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
    throw Object.assign(new Error("path must be an absolute directory"), { status: 400 });
  }
  if (!isAllowedExplorerPath(targetPath, options)) {
    throw Object.assign(new Error("path is outside the allowed Explorer roots"), { status: 403 });
  }
  try {
    if (!(options.stat ?? statSync)(targetPath).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw Object.assign(new Error("path must be an existing directory"), { status: 400 });
  }
  const spawnFn = options.spawn ?? spawn;
  const platform = options.platform ?? process.platform;
  const { command, args } = explorerOpenCommand(platform, targetPath);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
    let settled = false;
    let settleTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      callback(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("spawn", () => {
      child.unref?.();
      // xdg-open may hand the path to the desktop and exit immediately. Give
      // it a short window to report a real failure without blocking on the
      // file manager/browser it launches.
      settleTimer = setTimeout(() => finish(resolve, { ok: true }), 100);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, { ok: true });
      } else {
        finish(
          reject,
          new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`),
        );
      }
    });
  });
}
