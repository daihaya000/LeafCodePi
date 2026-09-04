import { spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_UPDATE_TIMEOUT_MS = 120_000;

function packageJsonPath(webDir) {
  return join(webDir, "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json");
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
        stdio: "inherit",
        timeout: PI_UPDATE_TIMEOUT_MS,
      },
    );
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
