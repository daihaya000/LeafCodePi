import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMirrorRoot, syncMirror } from "./web-build-mirror.mjs";
import { DEFAULT_HOST_CONTROL_PORT, dataDir, readPort } from "../host/src/config.js";
import { parseListeningPids } from "../host/src/port-plan.js";

/**
 * Single entry point for the production WebUI build, shared by `npm run build`
 * and host/src/index.js. Ported from LeafCode (scripts/build-web.mjs).
 *
 * The build never runs in the repository itself: it runs in the hard-link
 * mirror outside the OneDrive-synced tree (see scripts/web-build-mirror.mjs).
 */

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..");
const WEB_DIR = join(REPO_ROOT, "web");

/** Sibling directory used to keep the last good `.next` across a failed rebuild. */
export function previousBuildDir(distDir) {
  return `${distDir}.prev`;
}

/**
 * Move an existing production output aside before rebuilding. Returns true when
 * a previous build was stashed. Callers must restore or discard it afterwards.
 *
 * @param {string} distDir
 * @param {{
 *   existsSync?: (path: string) => boolean,
 *   renameSync?: (from: string, to: string) => void,
 *   rmSync?: (path: string, opts: object) => void,
 * }} [fsApi]
 */
export function stashPreviousBuild(distDir, fsApi = {}) {
  const exists = fsApi.existsSync ?? existsSync;
  const rename = fsApi.renameSync ?? renameSync;
  const remove = fsApi.rmSync ?? rmSync;
  if (!exists(distDir)) return false;
  const prev = previousBuildDir(distDir);
  remove(prev, { recursive: true, force: true });
  rename(distDir, prev);
  return true;
}

/**
 * Put a stashed production output back when the rebuild fails, so host startup
 * can still serve the last good BUILD_ID instead of leaving the mirror empty.
 *
 * @param {string} distDir
 * @param {{
 *   existsSync?: (path: string) => boolean,
 *   renameSync?: (from: string, to: string) => void,
 *   rmSync?: (path: string, opts: object) => void,
 * }} [fsApi]
 */
export function restorePreviousBuild(distDir, fsApi = {}) {
  const exists = fsApi.existsSync ?? existsSync;
  const rename = fsApi.renameSync ?? renameSync;
  const remove = fsApi.rmSync ?? rmSync;
  const prev = previousBuildDir(distDir);
  if (!exists(prev)) return false;
  remove(distDir, { recursive: true, force: true });
  rename(prev, distDir);
  return true;
}

/**
 * Drop the stashed copy after a successful rebuild.
 *
 * @param {string} distDir
 * @param {{
 *   existsSync?: (path: string) => boolean,
 *   rmSync?: (path: string, opts: object) => void,
 * }} [fsApi]
 */
export function discardPreviousBuild(distDir, fsApi = {}) {
  const exists = fsApi.existsSync ?? existsSync;
  const remove = fsApi.rmSync ?? rmSync;
  const prev = previousBuildDir(distDir);
  if (!exists(prev)) return false;
  remove(prev, { recursive: true, force: true });
  return true;
}

export function webUiPort(env = process.env) {
  const port = Number(env.LEAFCODE_PI_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3010;
}

/**
 * True when a command line is a `next start` serving the build mirror.
 *
 * Only that process is at risk: it holds the very `.next` this build replaces,
 * so rebuilding under it mixes chunk generations (ChunkLoadError) and stashing
 * `.next` aside breaks it outright. A `next dev` on the same port serves the
 * repository's `web/.next/dev` instead and is unaffected.
 */
export function isMirrorNextStart(commandLine, mirrorRoot) {
  const command = String(commandLine).replaceAll("/", "\\").toLowerCase();
  if (!/(?:^|[\\\s"])next["\s]+start(?:\s|$)/i.test(command)) return false;
  return command.includes(resolve(mirrorRoot).replaceAll("/", "\\").toLowerCase());
}

/**
 * Refuse to rebuild while the production WebUI is being served.
 *
 * The host always builds before it starts `next start`, so it passes
 * --skip-guard for its own pre-start build. This protects a manual
 * `npm run build` from replacing a build the tray host is serving.
 *
 * @returns {boolean} true when it is safe to build
 */
export function productionWebUiIsIdle({
  port = webUiPort(),
  mirrorRoot = resolveMirrorRoot(process.env, WEB_DIR),
  exec = execFileSync,
} = {}) {
  let pids;
  try {
    pids = parseListeningPids(exec("netstat", ["-ano"], { encoding: "utf8" }), port);
  } catch {
    // netstat unavailable: nothing can be proven, so do not block the build.
    return true;
  }

  for (const pid of pids) {
    let commandLine;
    try {
      commandLine = exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
        ],
        { encoding: "utf8" },
      );
    } catch {
      // A listener whose identity cannot be established might be the served
      // production build. Fail closed rather than risk replacing it.
      return false;
    }
    if (isMirrorNextStart(commandLine, mirrorRoot)) return false;
  }
  return true;
}

/**
 * Loopback control plane of the running tray host (`host-control.json`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string, encoding: string) => string} [read]
 */
export function hostControlUrl(env = process.env, read = readFileSync) {
  const override = env.LEAFCODE_PI_HOST_CONTROL_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  try {
    const raw = JSON.parse(read(join(dataDir(env), "host-control.json"), "utf8"));
    if (typeof raw?.url === "string" && raw.url) return raw.url.replace(/\/$/, "");
  } catch {
    // No host is running, or its file is unreadable: fall back to the default port.
  }
  return `http://127.0.0.1:${readPort(env.LEAFCODE_PI_HOST_CONTROL_PORT, DEFAULT_HOST_CONTROL_PORT)}`;
}

/**
 * A `next start` keeps serving the BUILD_ID it launched with, but this build has
 * just replaced the very `.next` underneath it: every chunk the already served
 * HTML references is gone, so `/_next/static/...` answers 500 and fresh clients
 * (typically a phone that has nothing cached) only get Next's "This page
 * couldn't load" error page. Hand the new generation over to the host serving it.
 *
 * @returns {Promise<"idle" | "restarted" | "manual">}
 */
export async function handOffToServedWebUi({
  port = webUiPort(),
  isIdle = productionWebUiIsIdle,
  controlUrl = hostControlUrl(),
  post = fetch,
} = {}) {
  if (isIdle({ port })) return "idle";
  try {
    const response = await post(`${controlUrl}/restart/webui`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.error("[build-web] the running WebUI was restarted onto the new build");
    return "restarted";
  } catch (err) {
    console.error(
      `[build-web] the running WebUI still serves the replaced build; restart it from the tray (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return "manual";
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  const port = webUiPort();
  if (!argv.includes("--skip-guard") && !productionWebUiIsIdle({ port })) {
    console.error(
      `[build-web] LeafCodePi is already serving port ${port}. Quit it from the tray before building.`,
    );
    return 1;
  }

  const mirror = syncMirror({ sourceDir: WEB_DIR });
  console.error(
    `[build-web] mirror ${mirror.mirrorRoot} (linked ${mirror.linked}, copied ${mirror.copied}, unchanged ${mirror.unchanged}, removed ${mirror.removed}, ${mirror.durationMs}ms)`,
  );

  const nextBin = join(mirror.mirrorRoot, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) {
    console.error(`[build-web] next was not found in the mirror: ${nextBin}`);
    return 1;
  }

  // A failed/cancelled Turbopack build can leave an incremental cache that
  // immediately panics on the next attempt. Retry once from a clean generated
  // directory. Webpack remains available as an explicit diagnostic fallback.
  const useWebpack = process.env.LEAFCODE_PI_USE_WEBPACK === "1";
  const nextArgs = [nextBin, "build", ...(useWebpack ? ["--webpack"] : [])];
  const buildOptions = { cwd: mirror.mirrorRoot, env: { ...process.env } };
  console.error(`[build-web] bundler: ${useWebpack ? "webpack" : "turbopack"}`);

  // Stash the last good `.next` instead of deleting it: a typecheck/Turbopack
  // failure must not leave host startup without a BUILD_ID.
  stashPreviousBuild(mirror.distDir);
  let status = run(process.execPath, nextArgs, buildOptions);
  if (status !== 0 && !useWebpack) {
    console.error("[build-web] Turbopack failed; clearing generated output and retrying once...");
    rmSync(mirror.distDir, { recursive: true, force: true });
    status = run(process.execPath, nextArgs, buildOptions);
  }
  if (status !== 0) {
    if (restorePreviousBuild(mirror.distDir)) {
      console.error(`[build-web] rebuild failed; restored previous production build at ${mirror.distDir}`);
    }
    return status;
  }

  if (!existsSync(join(mirror.distDir, "BUILD_ID"))) {
    console.error(`[build-web] the build finished without producing ${join(mirror.distDir, "BUILD_ID")}`);
    if (restorePreviousBuild(mirror.distDir)) {
      console.error(`[build-web] missing BUILD_ID; restored previous production build at ${mirror.distDir}`);
    }
    return 1;
  }

  discardPreviousBuild(mirror.distDir);
  console.error(`[build-web] build output: ${mirror.distDir}`);
  await handOffToServedWebUi({ port });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[build-web] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
