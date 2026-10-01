import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PACKAGES, PI_SDK_PACKAGE, STABLE_PI_VERSION, assertPiProjectVersions } from "../../shared/pi-dependencies.mjs";
import { dataDir, DEFAULT_WEBUI_PORT, readPort } from "./config.js";
import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { pidAlive, readLock } from "./lock.js";
import { getPortListenerStatus, runPortSnapshot } from "./port-scanner.js";
import { hardKillTree } from "./process-stop.js";

export const PI_PACKAGE_NAME = PI_SDK_PACKAGE;
export const PI_UPDATE_TIMEOUT_MS = 120_000;
/** Extra Host wait after the npm budget for rollback/cleanup (README: excluded from the 120s). */
export const PI_WORKER_CLEANUP_BUDGET_MS = 180_000;
/** Written by the worker while it owns the dependency directories; also what build gates check. */
export const DEPS_LOCK_NAME = ".leafcode-pi-deps.lock";
const WORKER = fileURLToPath(new URL("../../scripts/sync-pi-dependencies.mjs", import.meta.url));

export function installedPiVersion(dir, name = PI_PACKAGE_NAME) {
  try {
    return JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function runtimesAreIdle(env, platform) {
  const snapshot = runPortSnapshot({ platform });
  if (!snapshot) return false;
  return [readPort(env.LEAFCODE_PI_PORT, DEFAULT_WEBUI_PORT), readPort(env.LEAFCODE_PI_BACKEND_PORT, DEFAULT_BACKEND_PORT)]
    .every((port) => !getPortListenerStatus(port, snapshot, { platform }).listening);
}

function serializeLike(value, original) {
  const text = original.toString("utf8");
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(value, null, indent).replaceAll("\n", newline)}${newline}`;
}

function pinnedManifest(original, version) {
  const manifest = JSON.parse(original.toString("utf8"));
  manifest.dependencies ??= {};
  manifest.overrides ??= {};
  for (const name of PI_PACKAGES) {
    manifest.dependencies[name] = version;
    manifest.overrides[name] = `$${name}`;
  }
  return manifest;
}

function needsUpdate(project, version) {
  try {
    assertPiProjectVersions(JSON.parse(project.manifest), JSON.parse(project.lock), version, project.dir);
    return PI_PACKAGES.some((name) => installedPiVersion(project.dir, name) !== version);
  } catch {
    return true;
  }
}

/** Startup-only transaction: prepare both installs, then publish both or roll back both. */
export function autoUpdatePi({
  webDir, backendDir, env = process.env, platform = process.platform,
  spawnSync = defaultSpawnSync, log = () => {}, error = () => {},
  startupHostPid = null, now = () => Date.now(), runtimeIsIdle = runtimesAreIdle,
  fs = { renameSync, writeFileSync },
}) {
  if (env.LEAFCODE_PI_AUTO_UPDATE === "0") return { attempted: false, updated: false, skipped: true, safeToStart: true };
  const projects = [];
  let lockPath;
  let locked = false;
  let safeToStart = true;
  let committed = false;
  const deadline = now() + PI_UPDATE_TIMEOUT_MS;
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  function run(command, args, cwd) {
    const timeout = deadline - now();
    if (timeout <= 0) throw new Error("Pi synchronization timed out");
    const result = spawnSync(command, args, {
      cwd, env, shell: command === npm && platform === "win32", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout,
    });
    if (result?.error) throw result.error;
    if (result?.status !== 0) throw new Error(`${command === npm ? "npm" : "Pi validation"} ${args[0]} exited ${result?.status ?? "unknown"}`);
    return result.stdout ?? "";
  }
  try {
    if (!webDir || !backendDir || resolve(webDir) === resolve(backendDir)) throw new Error("Distinct Web and Backend directories are required");
    const host = readLock(join(dataDir(env), "host.lock"));
    if (host && pidAlive(host.pid) && host.pid !== startupHostPid) {
      throw new Error("Stop the Host before synchronizing Pi dependencies");
    }
    lockPath = join(webDir, DEPS_LOCK_NAME);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    locked = true;
    for (const dir of [webDir, backendDir]) {
      projects.push({ dir, manifest: readFileSync(join(dir, "package.json")), lock: readFileSync(join(dir, "package-lock.json")) });
    }
    const versions = PI_PACKAGES.map((name) => {
      const value = JSON.parse(run(npm, ["view", `${name}@latest`, "version", "--json"], webDir));
      const version = Array.isArray(value) && value.length === 1 ? value[0] : value;
      if (typeof version !== "string" || !STABLE_PI_VERSION.test(version)) throw new Error(`${name}@latest is not a stable version`);
      return version;
    });
    if (versions[0] !== versions[1]) throw new Error(`Pi latest tags disagree (SDK ${versions[0]}, AI ${versions[1]}); no partial update`);
    const version = versions[0];
    const changes = projects.filter((project) => needsUpdate(project, version));
    if (!changes.length) {
      log(`Pi SDK and AI are synchronized at latest v${version}`);
      return { attempted: true, updated: false, skipped: false, safeToStart: true, version };
    }
    if (!runtimeIsIdle(env, platform)) throw new Error("Web/Backend listeners must be idle before publishing new Pi dependencies");
    log(`Preparing Web and Backend Pi SDK/AI v${version} before starting sessions`);
    for (const project of changes) {
      project.stage = mkdtempSync(join(project.dir, ".leafcode-pi-update-"));
      writeFileSync(join(project.stage, "previous-package.json"), project.manifest);
      writeFileSync(join(project.stage, "previous-package-lock.json"), project.lock);
      writeFileSync(join(project.stage, "package.json"), serializeLike(pinnedManifest(project.manifest, version), project.manifest), "utf8");
      writeFileSync(join(project.stage, "package-lock.json"), project.lock);
      if (existsSync(join(project.dir, ".npmrc"))) writeFileSync(join(project.stage, ".npmrc"), readFileSync(join(project.dir, ".npmrc")));
      run(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], project.stage);
      project.nextManifest = readFileSync(join(project.stage, "package.json"));
      project.nextLock = readFileSync(join(project.stage, "package-lock.json"));
      assertPiProjectVersions(JSON.parse(project.nextManifest), JSON.parse(project.nextLock), version, project.dir);
      run(npm, ["ci", "--include=dev", "--no-audit", "--no-fund"], project.stage);
      for (const name of PI_PACKAGES) {
        if (installedPiVersion(project.stage, name) !== version) throw new Error(`${project.dir}: installed ${name} does not match v${version}`);
      }
      run(process.execPath, ["--input-type=module", "-e", [
        "await import('@earendil-works/pi-coding-agent');",
        "await import('@earendil-works/pi-ai/providers/anthropic');",
        "await import('@earendil-works/pi-ai/api/anthropic-messages');",
        ...(project.dir === webDir ? ["const {createRequire}=await import('node:module'); const require=createRequire(import.meta.url); new (require('better-sqlite3'))(':memory:').close();"] : []),
      ].join("\n")], project.stage);
    }
    // A manual npm install or another editor must not be overwritten by our prepared snapshot.
    for (const project of projects) {
      if (!readFileSync(join(project.dir, "package.json")).equals(project.manifest) ||
          !readFileSync(join(project.dir, "package-lock.json")).equals(project.lock)) {
        throw new Error(`${project.dir}: dependency files changed during synchronization`);
      }
    }
    if (!runtimeIsIdle(env, platform)) throw new Error("A runtime started during preparation; Pi dependencies were not published");
    for (const project of changes) {
      const modules = join(project.dir, "node_modules");
      if (existsSync(modules)) {
        fs.renameSync(modules, join(project.stage, "previous-node_modules"));
        project.previousModules = true;
      }
      fs.renameSync(join(project.stage, "node_modules"), modules);
      project.publishedModules = true;
      project.publishedFiles = true;
      fs.writeFileSync(join(project.dir, "package.json"), project.nextManifest);
      fs.writeFileSync(join(project.dir, "package-lock.json"), project.nextLock);
    }
    for (const project of changes) {
      if (!readFileSync(join(project.dir, "package.json")).equals(project.nextManifest) ||
          !readFileSync(join(project.dir, "package-lock.json")).equals(project.nextLock) ||
          PI_PACKAGES.some((name) => installedPiVersion(project.dir, name) !== version)) {
        throw new Error(`${project.dir}: published dependency bytes or versions did not validate`);
      }
    }
    committed = true;
    log(`Web and Backend Pi SDK/AI synchronized to latest v${version}`);
    return { attempted: true, updated: true, skipped: false, safeToStart: true, version };
  } catch (err) {
    if (!committed) {
      for (const project of [...projects].reverse()) {
        try {
          if (project.publishedFiles) {
            fs.writeFileSync(join(project.dir, "package.json"), project.manifest);
            fs.writeFileSync(join(project.dir, "package-lock.json"), project.lock);
          }
          if (project.publishedModules) rmSync(join(project.dir, "node_modules"), { recursive: true, force: true });
          if (project.previousModules) fs.renameSync(join(project.stage, "previous-node_modules"), join(project.dir, "node_modules"));
        } catch (rollbackError) {
          safeToStart = false;
          project.keepStage = true;
          error(`Pi rollback failed; backup retained at ${project.stage} (${rollbackError.message})`);
        }
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    error(`Pi synchronization failed (${message}); ${safeToStart ? "previous dependencies retained" : "startup refused"}`);
    return { attempted: true, updated: false, skipped: false, safeToStart, error: message };
  } finally {
    for (const project of projects) {
      if (project.stage && !project.keepStage) {
        try { rmSync(project.stage, { recursive: true, force: true }); }
        catch { error(`Pi staging cleanup failed at ${project.stage}`); }
      }
    }
    if (locked) rmSync(lockPath, { force: true });
  }
}

/**
 * The worker never runs longer than its own {@link PI_UPDATE_TIMEOUT_MS} npm budget plus
 * {@link PI_WORKER_CLEANUP_BUDGET_MS} for rollback/cleanup, then reports over IPC. The Host waits
 * that long and then stops waiting: a worker that never reports used to block startup forever while
 * holding host.lock, so every later launch only logged "Already running" and no WebUI ever came up.
 */
export const PI_WORKER_TIMEOUT_MS = PI_UPDATE_TIMEOUT_MS + PI_WORKER_CLEANUP_BUDGET_MS;

/** Run npm outside the Host event loop, but await completion before either runtime starts. */
export function updatePiBeforeStartup({
  webDir, backendDir, env = process.env, spawn = defaultSpawn, log = () => {}, error = () => {},
  timeoutMs = PI_WORKER_TIMEOUT_MS,
  killTree = (pid) => hardKillTree(pid, { platform: process.platform }),
  isAlive = pidAlive,
}) {
  if (env.LEAFCODE_PI_AUTO_UPDATE === "0") return Promise.resolve({ attempted: false, updated: false, skipped: true, safeToStart: true });
  return new Promise((resolveResult) => {
    let child;
    let result;
    let timer;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    try {
      child = spawn(process.execPath, [WORKER, "--web", webDir, "--backend", backendDir, "--startup-host", String(process.pid)], {
        env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (err) {
      error(`Pi synchronization worker failed (${err.message})`);
      settle({ safeToStart: false });
      return;
    }
    // The worker only publishes node_modules after every npm step succeeded, so one we have to kill
    // may have left that transaction half applied. Refuse startup instead of trusting whatever is on
    // disk; assertPiDependencyVersions refuses it too while the worker's lock file survives.
    timer = setTimeout(() => {
      const reason = `Pi synchronization worker did not report completion within ${timeoutMs}ms`;
      error(`${reason}; stopping it (pid ${child.pid ?? "unknown"})`);
      if (child.pid) killTree(child.pid);
      // Only drop the lock after the worker is confirmed gone. Removing it while the process still
      // lives lets a later Host start a second synchronizer against the same directories.
      const lockPath = webDir ? join(webDir, DEPS_LOCK_NAME) : null;
      if (lockPath && (!child.pid || !isAlive(child.pid))) rmSync(lockPath, { force: true });
      else if (lockPath) error(`Pi synchronization worker may still be alive; leaving ${DEPS_LOCK_NAME} in place`);
      settle({ attempted: true, updated: false, skipped: false, safeToStart: false, error: reason });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => log(String(chunk).trim()));
    child.stderr?.on("data", (chunk) => error(String(chunk).trim()));
    child.on("message", (message) => { result = message; });
    child.once("error", (err) => {
      error(`Pi synchronization worker failed (${err.message})`);
      settle({ safeToStart: false });
    });
    child.once("close", () => settle(result ?? { safeToStart: false }));
  });
}
