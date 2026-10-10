import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Host/Backend extension preparation, independent of frontend compilation.
export function extensionDependencyFingerprint(extensionDir) {
  return createHash("sha256")
    .update(JSON.stringify([
      readFileSync(join(extensionDir, "package.json"), "utf8").replace(/^\uFEFF/, ""),
      existsSync(join(extensionDir, "package-lock.json"))
        ? readFileSync(join(extensionDir, "package-lock.json"), "utf8")
        : null,
      process.version, process.platform, process.arch,
    ]))
    .digest("hex");
}

/** Check native SQLite in a child so the Host never locks the DLL it may update. */
function sqliteDependencyReady(directory, probeNative) {
  const result = probeNative(process.execPath,
    ["-e", "const Database = require('better-sqlite3'); new Database(':memory:').close();"], {
      cwd: directory,
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
  return !result.error && result.status === 0;
}

export function extensionDependenciesReady(extensionDir, dependencies, { probeNative = spawnSync } = {}) {
  if (!dependencies.every((name) => existsSync(join(extensionDir, "node_modules", name, "package.json")))) return false;
  return !dependencies.includes("better-sqlite3") || sqliteDependencyReady(extensionDir, probeNative);
}

/**
 * The Backend loads bundled extensions straight from the repository, but setup
 * installs only web/ and host/. Install each extension's declared dependencies
 * when the fingerprint is missing/stale or a declared package is absent; otherwise
 * a fresh clone (or lock-only update) silently loses tools such as web_search.
 * A failure is logged and the Host starts without those tools.
 */
export function ensureExtensionDependencies(extensionsDir = join(REPO_ROOT, "extensions"), { install = spawnSync, probeNative = spawnSync } = {}) {
  let entries;
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const installed = [];
  for (const entry of entries) {
    const dir = join(extensionsDir, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
    const hasLock = existsSync(join(dir, "package-lock.json"));
    let dependencies;
    let fingerprint;
    try {
      const packageJson = readFileSync(join(dir, "package.json"), "utf8").replace(/^\uFEFF/, "");
      dependencies = Object.keys(JSON.parse(packageJson).dependencies ?? {});
      if (!hasLock && dependencies.length === 0) continue;
      fingerprint = extensionDependencyFingerprint(dir);
    } catch {
      continue;
    }
    const stamp = join(dir, "node_modules", ".leafcode-pi-build-deps");
    const dependenciesReady = () => extensionDependenciesReady(dir, dependencies, { probeNative });
    const packagesPresent = dependenciesReady();
    let stampMatches = false;
    try {
      stampMatches = readFileSync(stamp, "utf8") === fingerprint;
    } catch {
      stampMatches = false;
    }
    if (packagesPresent && stampMatches) continue;
    console.error(`[extension-dependencies] installing extension dependencies in ${dir}`);
    // npm ci first removes node_modules. On Windows a live SQLite DLL can
    // block that removal after other packages are already gone. Repair an
    // existing tree in place; --no-save keeps the manifest and lock unchanged.
    const existingTree = existsSync(join(dir, "node_modules"));
    const installArgs = existingTree || !hasLock ? ["install", "--no-save"] : ["ci"];
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const installOptions = {
      cwd: dir,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: "inherit",
    };
    const result = install(npm,
      [...installArgs, "--include=dev", "--no-audit", "--no-fund"], installOptions);
    if (result.error || result.status !== 0) {
      console.error(`[extension-dependencies] npm ${installArgs[0]} failed in ${dir} (${result.error?.message ?? `exit ${result.status}`}); its tools stay unavailable`);
      continue;
    }
    // npm install can consider a package current even when its native binding
    // is absent. Explicitly rebuild only that module, without deleting the tree.
    let ready = dependenciesReady();
    if (!ready && dependencies.includes("better-sqlite3") &&
        dependencies.every((name) => existsSync(join(dir, "node_modules", name, "package.json")))) {
      console.error(`[extension-dependencies] rebuilding SQLite native binding in ${dir}`);
      const rebuild = install(npm, ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"], installOptions);
      ready = !rebuild.error && rebuild.status === 0 && dependenciesReady();
    }
    // An exit code alone cannot prove recovery (missing native bindings,
    // interrupted installs, or partially restored packages). Never stamp those.
    if (!ready) {
      console.error(`[extension-dependencies] dependency verification failed in ${dir}; its tools may remain unavailable`);
      continue;
    }
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(stamp, fingerprint, "utf8");
    } catch (error) {
      console.error(`[extension-dependencies] could not write extension deps stamp in ${dir} (${error instanceof Error ? error.message : String(error)})`);
    }
    installed.push(entry.name);
  }
  return installed;
}
