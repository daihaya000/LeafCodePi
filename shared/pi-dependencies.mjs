import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_AI_PACKAGE = "@earendil-works/pi-ai";
export const PI_PACKAGES = Object.freeze([PI_SDK_PACKAGE, PI_AI_PACKAGE]);
export const STABLE_PI_VERSION = /^\d+\.\d+\.\d+$/;

export function assertPiProjectVersions(manifest, lock, version, label = "Pi") {
  if (!STABLE_PI_VERSION.test(version)) throw new Error(`${label}: Pi must use an exact stable version`);
  for (const name of PI_PACKAGES) {
    if (manifest.dependencies?.[name] !== version || lock.packages?.[""].dependencies?.[name] !== version) {
      throw new Error(`${label}: ${name} must be pinned to ${version} in manifest and lockfile`);
    }
    if (manifest.overrides?.[name] !== `$${name}`) {
      throw new Error(`${label}: ${name} must override transitive copies to its direct version`);
    }
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    if (!entries.length || entries.some(([, entry]) => entry.version !== version)) {
      throw new Error(`${label}: ${name} has missing or mixed locked versions`);
    }
  }
}

export function assertInstalledPiVersions(dir, version) {
  for (const name of PI_PACKAGES) {
    const installed = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version;
    if (installed !== version) throw new Error(`${dir}: installed ${name} is ${installed}, expected ${version}`);
  }
}

/**
 * Build/start gates use the same contract as the updater, without contacting npm.
 * `requireUnlocked` is for the live checkout the worker locks; production mirrors never run that
 * worker, so a leftover `.leafcode-pi-deps.lock` there must not force a rebuild loop.
 */
export function assertPiDependencyVersions(webDir, backendDir, { requireUnlocked = true } = {}) {
  if (requireUnlocked && existsSync(join(webDir, ".leafcode-pi-deps.lock"))) {
    throw new Error("Pi synchronization is unfinished; retry after it completes or recover its retained staging backup");
  }
  let version;
  for (const dir of [webDir, backendDir]) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    version ??= manifest.dependencies?.[PI_SDK_PACKAGE];
    assertPiProjectVersions(manifest, lock, version, dir);
  }
  return version;
}
