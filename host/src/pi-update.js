import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_UPDATE_TIMEOUT_MS = 120_000;

function packageJsonPath(webDir) {
  return join(webDir, "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json");
}

function versionParts(version) {
  return String(version).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

/** True when `a` is a strictly newer dotted version than `b`. */
function isNewerVersion(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

/**
 * The Backend runs the sessions and the WebUI shares its typed modules, so the two installs must
 * carry the same SDK. `npm update` only ever touches the WebUI install, which left a newer WebUI SDK
 * beside an older Backend one (two incompatible declarations; every WebUI rebuild then fails its
 * typecheck gate). The Backend follows the WebUI install; it runs the new SDK after its next restart.
 */
function alignBackendSdk({ webDir, backendDir, npm, platform, spawn, log, error }) {
  const web = installedPiVersion(webDir);
  const backend = installedPiVersion(backendDir);
  if (!web || !backend || !isNewerVersion(web, backend)) return false;
  let child;
  try {
    child = spawn(npm, ["install", `${PI_PACKAGE_NAME}@${web}`, "--save-exact", "--no-audit", "--no-fund"], {
      cwd: backendDir,
      shell: platform === "win32",
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (err) {
    error(`Backend Pi SDK alignment failed (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
  child.once("error", (err) => {
    error(`Backend Pi SDK alignment failed (${err instanceof Error ? err.message : String(err)})`);
  });
  child.once("close", (code) => {
    if (code !== 0) {
      error(`Backend Pi SDK alignment failed (npm exited ${code ?? "unknown"}); the Backend stays on v${backend}`);
      return;
    }
    log(`Backend Pi SDK aligned from v${backend} to v${web}; restart the Backend to run it`);
  });
  child.unref?.();
  return true;
}

function writeCapturedOutput(result) {
  if (result?.stdout) process.stdout.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
}

export function installedPiVersion(webDir) {
  try {
    const file = packageJsonPath(webDir);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Update the embedded Pi dependency without making startup depend on npm. */
export function autoUpdatePi({
  webDir,
  env = process.env,
  platform = process.platform,
  spawnSync = defaultSpawnSync,
  log = () => {},
  error = () => {},
}) {
  if (env.LEAFCODE_PI_AUTO_UPDATE === "0") {
    return { attempted: false, updated: false, skipped: true };
  }

  const before = installedPiVersion(webDir);
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  let result;
  try {
    result = spawnSync(
      npm,
      ["update", PI_PACKAGE_NAME, "--no-audit", "--no-fund"],
      {
        cwd: webDir,
        shell: platform === "win32",
        windowsHide: true,
        // npm changes process.title on Windows. Pipe its output so it cannot
        // replace the LeafCodePi launcher title on the shared console.
        stdio: platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",
        timeout: PI_UPDATE_TIMEOUT_MS,
      },
    );
    if (platform === "win32") writeCapturedOutput(result);
  } catch (err) {
    error(`Pi auto-update failed; continuing with the installed version (${err instanceof Error ? err.message : String(err)})`);
    return { attempted: true, updated: false, skipped: false };
  }

  if (result?.error || result?.status !== 0) {
    error(
      `Pi auto-update failed; continuing with the installed version (${result?.error?.message ?? `npm exited ${result?.status ?? "unknown"}`})`,
    );
    return { attempted: true, updated: false, skipped: false };
  }

  const after = installedPiVersion(webDir);
  if (before && after && before !== after) {
    log(`Pi updated from v${before} to v${after}`);
  } else if (after) {
    log(`Pi is up to date (v${after})`);
  } else {
    log("Pi auto-update completed");
  }
  return {
    attempted: true,
    updated: Boolean(before && after && before !== after),
    skipped: false,
    version: after,
  };
}

/**
 * `npm update` のネットワーク待ちで起動を止めない非同期版。WebUI が ready に
 * なってから呼ぶ。結果はログだけに残し、呼び出し側は待たない。
 */
export function autoUpdatePiInBackground({
  webDir,
  backendDir,
  env = process.env,
  platform = process.platform,
  spawn = defaultSpawn,
  log = () => {},
  error = () => {},
}) {
  if (env.LEAFCODE_PI_AUTO_UPDATE === "0") {
    return { attempted: false, skipped: true };
  }

  const before = installedPiVersion(webDir);
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  let child;
  try {
    child = spawn(npm, ["update", PI_PACKAGE_NAME, "--no-audit", "--no-fund"], {
      cwd: webDir,
      shell: platform === "win32",
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (err) {
    error(`Pi auto-update failed; continuing with the installed version (${err instanceof Error ? err.message : String(err)})`);
    return { attempted: true, skipped: false };
  }
  child.once("error", (err) => {
    error(`Pi auto-update failed; continuing with the installed version (${err instanceof Error ? err.message : String(err)})`);
  });
  const align = () => {
    if (backendDir) alignBackendSdk({ webDir, backendDir, npm, platform, spawn, log, error });
  };
  child.once("close", (code) => {
    if (code !== 0) {
      error(`Pi auto-update failed; continuing with the installed version (npm exited ${code ?? "unknown"})`);
      align();
      return;
    }
    const after = installedPiVersion(webDir);
    if (before && after && before !== after) {
      log(`Pi updated from v${before} to v${after}`);
    } else if (after) {
      log(`Pi is up to date (v${after})`);
    } else {
      log("Pi auto-update completed");
    }
    align();
  });
  child.unref?.();
  return { attempted: true, skipped: false };
}
