import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SysTrayImport from "systray2";
import { bindHost, dataDir, DEFAULT_HOST_CONTROL_PORT, DEFAULT_LLAMA_SERVER_PORT, DEFAULT_WEBUI_PORT, readPort, shouldOpenBrowser as envAllowsBrowser, shouldRebindWebUi, shouldUseTray, webUiUrl, withQuietExperimentalWarnings } from "./config.js";
import { readBrowserConfig, writeBrowserConfig } from "./browser-config.js";
import { isThisModuleEntrypoint } from "./entry.js";
import { createLlamaControlServer, closeControlServer, listenControlServer } from "./llama-control-server.js";
import { createLoopbackWebUiProxy, listenLoopbackWebUiProxy, closeLoopbackWebUiProxy } from "./loopback-webui-proxy.js";
import { createLlamaServerService } from "./llama-server-service.js";
import { awaitLockOwner, lockOwnerAlive, pidAlive, processStartKey, readLock, removeLock, writeLock } from "./lock.js";
import { createRateLimitedReporter } from "./rate-limited-report.js";
import { createLogFileWriter, formatLogLine } from "./log-file.js";
import { getListeningPids, getPortListenerStatus } from "./port-scanner.js";
import { hardKillTree, stopProcessTreeGracefully } from "./process-stop.js";
import { stopOrphanedWebUi } from "./stale-webui.js";
import {
  buildHostRestartScript,
  buildHostRestartWaitProgram,
  consumeHostRestartBuild,
  hostStdoutLogFile,
  waitForHostRestartChildSpawn,
} from "./host-restart.js";
import { serviceRestartBusyReason } from "./runtime-restart-guard.js";
import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { createBackendService, shouldRunBackend } from "./backend-service.js";
import { readBackendHealth, waitForBackendReady } from "./backend-health.js";
import { BACKEND_HANG_STRIKE_LIMIT, backendHangShouldRestart, nextBackendHangStrikes } from "./backend-hang-watch.js";
import { consumePiUpdateRequest, installedPiVersion, readPiUpdateRequest, readPiUpdateState, requestPiUpdate, updatePiBeforeStartup, writePiUpdateState, PI_UPDATE_MODES } from "./pi-update.js";
import { assertInstalledPiVersions, assertPiDependencyVersions, DEFAULT_PI_VERSION, PI_DEPS_LOCK_NAME, piDepsLockHeld } from "../../shared/pi-dependencies.mjs";
import { buildBackendWithFallback } from "./backend-build.js";
import { pullLatestSources, pullLatestSourcesAsync } from "./git-pull.js";
import { createTranslationService } from "./translation-service.js";
import { openProjectInExplorer } from "./open-explorer.js";
import { withLocalLeafcodeTempEnv } from "./tray-temp.js";
import { withSafeInitialMenu } from "./tray-startup.js";
import {
  ensureWebUiAuth,
  isLoopbackBind,
  readWebUiAuthConfig,
  webUiAuthPath,
  writeWebUiAuthConfig,
} from "./webui-auth.js";
import {
  consumeSkipStaleRebuild,
  createConsecutiveFailureTracker,
  formatWebStatus,
  getPostBuildLaunchPlan,
  getWebLaunchPlan,
  isWebBuildStale,
  procRunning,
  staleRebuildFailureAction,
} from "./web-plan.js";
import {
  isMirroredNextCliReady,
  mirrorDistDir,
  resolveMirrorRoot,
  syncMirror,
} from "../../scripts/web-build-mirror.mjs";
import { ensureBuildDependencies, ensureExtensionDependencies } from "../../scripts/build-web.mjs";

const SysTray =
  withSafeInitialMenu(SysTrayImport?.default?.default || SysTrayImport?.default || SysTrayImport);

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(__dirname, "..");
const REPO_ROOT = join(HOST_DIR, "..");
const WEB_DIR = join(REPO_ROOT, "web");
/**
 * Production builds and `next start` both run in the local workspace outside
 * the OneDrive-synced tree (scripts/web-build-mirror.mjs), so the sync client
 * can never touch a build that is being written or served. `next dev` keeps
 * running from WEB_DIR — Next 16 puts its output in `.next/dev`, which no
 * longer collides with a production `.next`.
 */
const WEB_MIRROR_DIR = resolveMirrorRoot(process.env, WEB_DIR);
const WEB_DIST_DIR = mirrorDistDir(WEB_MIRROR_DIR);
const DATA_DIR = dataDir();
const LOCK_FILE = join(DATA_DIR, "host.lock");
const HOST_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HOST_DIR, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

let WEBUI_HOST = bindHost();
const WEBUI_PORT = readPort(process.env.LEAFCODE_PI_PORT, DEFAULT_WEBUI_PORT);
let WEBUI_URL = webUiUrl(WEBUI_HOST, WEBUI_PORT);
let WEBUI_AUTH = ensureWebUiAuth(process.env, WEBUI_HOST, DATA_DIR);
const CONTROL_PORT = readPort(process.env.LEAFCODE_PI_HOST_CONTROL_PORT, DEFAULT_HOST_CONTROL_PORT);
const LLAMA_SERVER_PORT = readPort(process.env.LEAFCODE_PI_LLAMA_PORT, DEFAULT_LLAMA_SERVER_PORT);
const CONTROL_FILE = join(DATA_DIR, "host-control.json");
const BACKEND_GENERATION_FILE = join(DATA_DIR, "backend-generation.txt");
const MAX_WEB_RESTARTS = 3;
const MAX_TRAY_RESTARTS = 3;
// The budgets stop rapid crash loops, not unrelated failures spread over a long
// session. A process that stays up this long gets its restart allowance back.
const RESTART_BUDGET_RESET_MS = 60_000;
// The killed WebUI disappears within a few ms (process.kill(pid, 0) poll), so
// keep the settle time short; the try budget is only a backstop for a kill
// that never lands.
const KILL_POLL_MS = 25;
const KILL_POLL_TRIES = 80;
const STOP_SETTLE_MS = 150;

function webUiAuthSettings() {
  const config = readWebUiAuthConfig(DATA_DIR);
  const envToken = process.env.LEAFCODE_PI_WEBUI_TOKEN?.trim() || null;
  const remote = !isLoopbackBind(WEBUI_HOST);
  return {
    enabled: config.enabled,
    remote,
    authRequired: remote && config.enabled && Boolean(envToken || config.token),
    tokenConfigured: Boolean(envToken || config.token),
    envManaged: Boolean(envToken),
  };
}

function isLocalClientOrigin(origin) {
  try {
    const candidate = new URL(origin);
    if (candidate.protocol !== "http:") return false;
    if (candidate.origin === new URL(WEBUI_URL).origin) return true;
    return (
      isLoopbackBind(candidate.hostname) &&
      Number(candidate.port || 80) === WEBUI_PORT
    );
  } catch {
    return false;
  }
}

const llamaServerService = createLlamaServerService({
  batPath: join(REPO_ROOT, "scripts", "llama-server-load.bat"),
  platform: process.platform,
  port: LLAMA_SERVER_PORT,
  ownershipFile: join(DATA_DIR, "llama-server-owner.json"),
  getListeningPids,
  getPortListenerStatus,
  getProcessStartTime: processStartTime,
  isOwnedProcess,
  isLlamaServerProcess,
  stopProcessTreeGracefully,
  // Host tray follows shouldUseTray(). The extra llama-server icon is Windows-only
  // (WMI-detached so it can outlive the host). Linux/macOS keep a single host tray.
  trayEnabled: process.platform === "win32" && shouldUseTray(),
  trayScript: join(__dirname, "llama-server-tray.mjs"),
});

/** Local en→ja reasoning translation (Argos Translate via Python stdio worker). */
const translationService = createTranslationService({
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  log,
});

/** @type {import("node:http").Server | null} */
let controlServer = null;
/** @type {import("node:http").Server | null} */
let loopbackWebUiProxy = null;

const iconData = JSON.parse(readFileSync(join(__dirname, "icon.json"), "utf8"));
const TRAY_ICON = iconData.base64;

let logWriter = null;

/** @type {import("node:child_process").ChildProcess | null} */
let webProc = null;
let webBuildProc = null;
let webBuildPromise = null;
/** @type {import("systray2").default | null} */
let systray = null;
let quitting = false;
let webRestarts = 0;
let trayRestarts = 0;
let trayCopyDir = true;
let restarting = false;
let backendHangStrikes = 0;

/** Claim the single-flight restart lock; clears hang-watch strikes so a manual restart cannot be followed by an immediate hang re-restart. */
function claimServiceRestart() {
  if (restarting) return false;
  restarting = true;
  backendHangStrikes = 0;
  return true;
}
/**
 * The Host's independent Backend process, or null when the operator did not ask for one. It stays
 * always attached: it owns the Pi runtime, and two owners would double-write
 * the store, leases and sessions.
 */
// Production runs the Backend by default: it owns the Pi runtime, so the WebUI is always its client.
const backendService = shouldRunBackend(process.env)
  ? createBackendService({
      repoRoot: REPO_ROOT,
      env: process.env,
      spawn,
      log,
      error,
      onOutput: (level, text) => {
        logWriter?.write({ ts: Date.now(), source: "backend", level, text });
      },
    })
  : null;
let bindingReconcileInProgress = false;
const expectedWebExitPids = new Set();

const statusWebItem = {
  title: "LeafCodePi: ...",
  tooltip: WEBUI_URL,
  enabled: false,
};

function refreshWebUiBinding() {
  const nextHost = bindHost();
  if (nextHost === WEBUI_HOST) return;
  const previousHost = WEBUI_HOST;
  WEBUI_HOST = nextHost;
  WEBUI_URL = webUiUrl(WEBUI_HOST, WEBUI_PORT);
  WEBUI_AUTH = ensureWebUiAuth(process.env, WEBUI_HOST, DATA_DIR);
  statusWebItem.tooltip = WEBUI_URL;
  log(`WebUI bind address changed from ${previousHost} to ${WEBUI_HOST}`);
}

async function reconcileWebUiBinding() {
  if (quitting || restarting || bindingReconcileInProgress || !webProc) return;
  if (!shouldRebindWebUi(WEBUI_HOST)) return;

  bindingReconcileInProgress = true;
  try {
    log("Tailscale bind address changed; restarting WebUI to expose the new address...");
    await restartWeb();
  } catch (err) {
    error(`WebUI bind address recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    bindingReconcileInProgress = false;
  }
}

function log(text) {
  const line = formatLogLine({ ts: Date.now(), source: "host", level: "log", text });
  console.log(`[LeafCodePi] ${text}`);
  logWriter?.write({ ts: Date.now(), source: "host", level: "log", text });
  return line;
}

function error(text) {
  console.error(`[LeafCodePi] ERROR ${text}`);
  logWriter?.write({ ts: Date.now(), source: "host", level: "error", text });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `next dev` runs from the repository; production runs from the mirror. */
function nextBin(projectDir = WEB_DIR) {
  return join(projectDir, "node_modules", "next", "dist", "bin", "next");
}

function hasProductionBuild() {
  return existsSync(join(WEB_DIST_DIR, "BUILD_ID"));
}

function webDistDir() {
  return WEB_DIST_DIR;
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function writeCapturedOutput(result) {
  if (result?.stdout) process.stdout.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
}

function killTree(pid) {
  hardKillTree(pid, { platform: process.platform });
}

function processCommandLine(pid) {
  try {
    const result =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: "utf8", timeout: 3000, windowsHide: true },
          )
        : spawnSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          });
    if (result.error || result.status !== 0) return null;
    const command = String(result.stdout ?? "").trim();
    return command || null;
  } catch {
    return null;
  }
}

function commandMarkerName(marker) {
  const normalized = String(marker ?? "").replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function processStartTime(pid) {
  try {
    const result =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
            ],
            { encoding: "utf8", timeout: 3000, windowsHide: true },
          )
        : spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          });
    if (result.error || result.status !== 0) return null;
    const value = String(result.stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function commandLineMatches(pid, marker) {
  const command = processCommandLine(pid);
  const name = commandMarkerName(marker);
  if (!command || !name) return null;
  const lower = command.toLowerCase();
  const isBoundary = (char) =>
    !char || char <= " " || char === '"' || char === "'" || char === "/" || char === "\\";
  for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
    if (isBoundary(lower[at - 1]) && isBoundary(lower[at + name.length])) return true;
  }
  return false;
}

function isOwnedProcess(pid, marker) {
  return commandLineMatches(pid, marker) === true;
}

function isLlamaServerProcess(pid, marker) {
  return commandLineMatches(pid, marker) === true;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (err) => error(`Could not open browser: ${err.message}`));
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      error(
        `Could not open browser: ${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
      );
    }
  });
  child.unref();
}

/** Browser auto-open is off by default; enabled via the settings UI. */
function shouldOpenBrowser() {
  return envAllowsBrowser() && readBrowserConfig().autoOpenBrowser;
}

async function isHttpUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitUntilReady(url, label, seconds = 90, proc) {
  const iterations = Math.max(1, Math.ceil((seconds * 1000) / 250));
  for (let i = 0; i < iterations; i += 1) {
    if (await isHttpUp(url)) {
      log(`${label} is ready`);
      return true;
    }
    if (proc && !procRunning(proc())) {
      error(`${label} exited before becoming ready (${url})`);
      return false;
    }
    await sleep(250);
  }
  error(`${label} did not become ready in time (${url})`);
  return false;
}

function pipeChild(label, child) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
    logWriter?.write({ ts: Date.now(), source: label, level: "log", text: String(chunk) });
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
    logWriter?.write({ ts: Date.now(), source: label, level: "error", text: String(chunk) });
  });
}

function runNodeScript(args, options) {
  return spawn(process.execPath, args, {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "pipe",
    ...options,
    env: withQuietExperimentalWarnings(options?.env ?? process.env),
  });
}

function installWebIfNeeded() {
  if (!existsSync(join(WEB_DIR, "node_modules", "next"))) {
    log("Installing web dependencies...");
    const result = spawnSync(
      process.platform === "win32" ? "cmd.exe" : npmCmd(),
      process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd install"] : ["install"],
      {
        cwd: WEB_DIR,
        windowsHide: true,
        // npm changes process.title on Windows. Pipe its output so it cannot
        // replace the LeafCodePi launcher title on the shared console.
        stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",
      },
    );
    if (process.platform === "win32") writeCapturedOutput(result);
    if (result.status !== 0) {
      throw new Error(`npm install (web) exited ${result.status}`);
    }
  }
}

function buildWeb(reason = "missing", { pull = true } = {}) {
  if (webBuildPromise) return webBuildPromise;

  const promise = new Promise((resolve, reject) => {
    const reasonText =
      reason === "stale"
        ? "Production LeafCodePi build is stale (sources newer than BUILD_ID); rebuilding…"
        : reason === "manual"
          ? "Rebuilding the production LeafCodePi build on request…"
          : "Production LeafCodePi build is missing; rebuilding…";
    log(reasonText);
    if (pull) pullLatestSources({ repoRoot: REPO_ROOT, log, error });
    // Syncs sources and builds in the local workspace; see scripts/build-web.mjs.
    // --skip-guard: the host builds before it starts `next start`, so the only
    // listener the guard could find would be a WebUI this host is replacing.
    const child = runNodeScript([join(REPO_ROOT, "scripts", "build-web.mjs"), "--skip-guard"], {
      cwd: REPO_ROOT,
    });
    webBuildProc = child;
    void refreshStatusMenu();
    pipeChild("build", child);
    child.on("error", reject);
    child.on("close", (code) => {
      webBuildProc = null;
      void refreshStatusMenu();
      if (code === 0) resolve();
      else reject(new Error(`next build exited ${code}`));
    });
  });
  webBuildPromise = promise;
  const clearPromise = () => {
    if (webBuildPromise === promise) webBuildPromise = null;
  };
  promise.then(clearPromise, clearPromise);
  return promise;
}

/** How long a restarted Host waits for the Backend it is bringing back before serving the WebUI. */
export const BACKEND_START_READY_TIMEOUT_MS = 20_000;

function publishBackendGeneration() {
  const temporary = `${BACKEND_GENERATION_FILE}.tmp`;
  writeFileSync(temporary, backendService?.status().generation ?? "", "utf8");
  renameSync(temporary, BACKEND_GENERATION_FILE);
}

async function spawnWeb({ pull = true, forceBuild = false } = {}) {
  // A client WebUI needs its owner first: bring the Backend back attached and give the runtime a
  // bounded moment to attach, so the restarted WebUI does not serve failures while it catches up.
  if (backendService) {
    try {
      backendService.start({ attachRuntime: true });
      publishBackendGeneration();
      const clientEnv = backendService.clientEnv();
      const ready = await waitForBackendReady({
        read: () =>
          readBackendHealth({
            baseUrl: clientEnv.LEAFCODE_PI_BACKEND_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
            token: clientEnv.LEAFCODE_PI_BACKEND_TOKEN,
            expectedGeneration: backendService.status().generation ?? "",
          }),
        timeoutMs: BACKEND_START_READY_TIMEOUT_MS,
      });
      if (!ready.ok) {
        error(`Backend was not ready before the WebUI client started (${ready.reason ?? "timeout"})`);
      }
    } catch (err) {
      error(`Backend could not be started for the WebUI client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  installWebIfNeeded();
  let hasBuild = hasProductionBuild();
  const skipStaleBuild = consumeSkipStaleRebuild(process.env);
  const actualBuildStale = hasBuild && isWebBuildStale(WEB_DIR, webDistDir());
  const buildStale = !skipStaleBuild && actualBuildStale;
  if (skipStaleBuild && actualBuildStale) {
    log("Skipping stale production rebuild during host replacement; serving the existing build");
  }
  let plan = getWebLaunchPlan(process.env.LEAFCODE_PI_MODE, hasBuild, buildStale);
  if (forceBuild || plan.needsBuild) {
    const rebuildReason = forceBuild ? "manual" : hasBuild && buildStale ? "stale" : "missing";
    try {
      await buildWeb(rebuildReason, { pull });
    } catch (err) {
      hasBuild = hasProductionBuild();
      const failureAction = staleRebuildFailureAction({ hasBuild });
      if (failureAction === "continue-stale") {
        error(
          `Rebuild failed; continuing with the existing production build (${err instanceof Error ? err.message : String(err)})`,
        );
      } else {
        error(
          `Production build failed; falling back to next dev (${err instanceof Error ? err.message : String(err)})`,
        );
        // build-web.mjs restores the last good `.next` after a failure. Only a
        // build that left no BUILD_ID at all is junk worth removing.
        if (!hasProductionBuild()) rmSync(webDistDir(), { recursive: true, force: true });
        process.env.LEAFCODE_PI_MODE = "dev";
      }
    }
    hasBuild = hasProductionBuild();
    const stillStale = hasBuild && isWebBuildStale(WEB_DIR, webDistDir());
    plan = getPostBuildLaunchPlan(process.env.LEAFCODE_PI_MODE, hasBuild, stillStale);
    if (plan.staleAfterBuild) {
      log("Sources changed during the build; serving this build and rebuilding again on the next restart");
    }
  }

  if (plan.needsBuild && process.env.LEAFCODE_PI_MODE === "prod") {
    throw new Error("LeafCodePi production build is unavailable");
  }

  const useProd = plan.useProd && hasProductionBuild();
  if (useProd && !isMirroredNextCliReady(WEB_MIRROR_DIR)) {
    log("Production workspace is missing the Next.js CLI; installing locally…");
    syncMirror({ sourceDir: WEB_DIR, mirrorRoot: WEB_MIRROR_DIR });
    ensureBuildDependencies(WEB_MIRROR_DIR);
  }
  // Tailscale can disappear or change while a production build is running.
  // Resolve the automatic bind again immediately before launching Next.js.
  refreshWebUiBinding();
  if (isLoopbackBind(WEBUI_HOST) || WEBUI_HOST === "0.0.0.0" || WEBUI_HOST === "::") {
    await closeLoopbackWebUiProxy(loopbackWebUiProxy);
    loopbackWebUiProxy = null;
  } else if (!loopbackWebUiProxy) {
    const proxy = createLoopbackWebUiProxy(() => ({ host: WEBUI_HOST, port: WEBUI_PORT }));
    try {
      await listenLoopbackWebUiProxy(proxy, WEBUI_PORT);
      loopbackWebUiProxy = proxy;
      log(`Host-only WebUI proxy listening on http://127.0.0.1:${WEBUI_PORT}`);
    } catch (err) {
      proxy.close();
      error(`Host-only WebUI proxy unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Production serves the mirrored project; dev keeps running from the repo.
  const projectDir = useProd ? WEB_MIRROR_DIR : WEB_DIR;
  const args = useProd
    ? [nextBin(projectDir), "start", "--hostname", WEBUI_HOST, "--port", String(WEBUI_PORT)]
    : [nextBin(projectDir), "dev", "--hostname", WEBUI_HOST, "--port", String(WEBUI_PORT)];
  // A previous host that died without cleanup leaves its WebUI holding the port.
  await stopOrphanedWebUi({
    port: WEBUI_PORT,
    projectDirs: [WEB_MIRROR_DIR, WEB_DIR],
    getListeningPids,
    stopProcessTreeGracefully,
    excludePids: webProc?.pid ? [webProc.pid] : [],
    log,
  }).catch((err) => error(`Orphaned WebUI check failed: ${err instanceof Error ? err.message : String(err)}`));
  WEBUI_AUTH = ensureWebUiAuth(process.env, WEBUI_HOST, DATA_DIR);
  const webUiAuth = WEBUI_AUTH;
  log(`Starting LeafCodePi (${useProd ? "production" : "dev"}) on ${WEBUI_URL}`);
  const child = runNodeScript(args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(WEBUI_PORT),
      LEAFCODE_PI_HOST: WEBUI_HOST,
      LEAFCODE_PI_PORT: String(WEBUI_PORT),
      LEAFCODE_PI_BIND_HOST: WEBUI_HOST,
      LEAFCODE_PI_WEBUI_AUTH: webUiAuth.authRequired ? "required" : "",
      LEAFCODE_PI_WEBUI_TOKEN: webUiAuth.token ?? "",
      // Bundled WebUI extensions and skills live in the repo (prod runs from the web/ mirror).
      LEAFCODE_PI_EXTENSIONS_DIR: join(REPO_ROOT, "extensions"),
      LEAFCODE_PI_SKILLS_DIR: join(REPO_ROOT, "skills"),
      // How the WebUI reaches the Backend, and which runtime generation to expect. Absent when no
      // Backend is configured, so the WebUI keeps its in-process path.
      ...(backendService ? {
        ...backendService.clientEnv(),
        LEAFCODE_PI_BACKEND_GENERATION_FILE: BACKEND_GENERATION_FILE,
      } : {}),
    },
  });
  webProc = child;
  pipeChild("webui", child);
  // The Backend runs alongside the WebUI; start() is idempotent across WebUI restarts.
  try {
    backendService?.start();
  } catch (err) {
    error(`Backend start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stableTimer = setTimeout(() => {
    if (!quitting && webProc === child) webRestarts = 0;
  }, RESTART_BUDGET_RESET_MS);
  stableTimer.unref?.();
  child.on("error", (err) => error(`WebUI spawn error: ${err.message}`));
  child.on("close", (code, signal) => {
    clearTimeout(stableTimer);
    const expected = child.pid ? expectedWebExitPids.delete(child.pid) : false;
    const wasCurrent = webProc === child;
    if (!quitting) log(`WebUI exited (code=${code}, signal=${signal ?? "none"})`);
    if (wasCurrent) webProc = null;
    void refreshStatusMenu();
    if (!quitting && !expected && wasCurrent) scheduleWebRestart();
  });
}

function scheduleWebRestart() {
  if (quitting || restarting) return;
  if (webRestarts >= MAX_WEB_RESTARTS) {
    error(`WebUI restart budget exhausted (${MAX_WEB_RESTARTS})`);
    return;
  }
  webRestarts += 1;
  const delay = Math.min(1000 * webRestarts, 5000);
  log(`Restarting WebUI in ${delay}ms (attempt ${webRestarts}/${MAX_WEB_RESTARTS})...`);
  setTimeout(() => {
    spawnWeb().catch((err) => error(err instanceof Error ? err.message : String(err)));
  }, delay);
}

async function stopWeb() {
  const child = webProc;
  if (!child?.pid) return;
  expectedWebExitPids.add(child.pid);
  killTree(child.pid);
  webProc = null;
  for (let i = 0; i < KILL_POLL_TRIES; i += 1) {
    if (!pidAlive(child.pid)) break;
    await sleep(KILL_POLL_MS);
  }
}

/**
 * Only standalone development owns sessions inside Next.js. A production client
 * can restart freely without interrupting the independent Backend.
 */
async function webUiRestartBlockReason() {
  // A concurrent restart must be refused before the control plane answers 202.
  const busy = serviceRestartBusyReason(restarting);
  if (busy) return busy;
  // Production WebUI is a Backend client: refuse while that Backend is not ready
  // so the operator gets a 409 instead of a silent no-op after 202.
  if (backendService) {
    const clientEnv = backendService.clientEnv();
    const health = await readBackendHealth({
      baseUrl: clientEnv.LEAFCODE_PI_BACKEND_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
      token: clientEnv.LEAFCODE_PI_BACKEND_TOKEN,
      expectedGeneration: backendService.status().generation ?? "",
    });
    if (health.ok !== true || health.ready !== true) {
      return "Backend が準備できていないため WebUI の再起動を拒否しました。Backend の状態を確認してから再試行してください。";
    }
    // Independent Backend owns sessions; restarting the client cannot interrupt them.
    return null;
  }
  try {
    const response = await fetch(`${WEBUI_URL}/api/goal-loop/active`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      headers:
        WEBUI_AUTH.authRequired && WEBUI_AUTH.token
          ? { authorization: `Bearer ${WEBUI_AUTH.token}` }
          : {},
    });
    if (!response.ok) return webUiRestartUnknownReason(`HTTP ${response.status}`);
    const body = await response.json();
    const active = Number(body?.active) || 0;
    if (active <= 0) return null;
    return `Goal Loop が ${active} 件実行中のため WebUI の再起動を拒否しました。ループを停止・完了してから再試行してください。`;
  } catch (err) {
    // Nothing is listening: no live Next.js sessions to protect, recovery stays available.
    const code = err?.cause?.code ?? err?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") return null;
    return webUiRestartUnknownReason(err instanceof Error ? err.message : String(err));
  }
}

/** A living standalone WebUI whose Goal Loop state is unknown must fail closed (as the Backend guard does). */
function webUiRestartUnknownReason(detail) {
  return `Goal Loop の実行状況を確認できないため WebUI の再起動を拒否しました（${detail}）。WebUI の応答を確認してから再試行してください。`;
}

/**
 * Restarting the runtime ends live sessions. Probe the owner directly, including
 * when WebUI is down; an unknown state on a living owner must fail closed.
 */
async function backendRestartBlockReason() {
  const busy = serviceRestartBusyReason(restarting);
  if (busy) return busy;
  // A confirmed dead owner has no live sessions to protect; recovery stays available.
  if (!backendService || backendService.status().state !== "running") return null;
  const { backendRuntimeRestartBlockReason } = await import("./runtime-restart-guard.js");
  const env = backendService.clientEnv();
  return backendRuntimeRestartBlockReason({
    baseUrl: env.LEAFCODE_PI_BACKEND_URL,
    token: env.LEAFCODE_PI_BACKEND_TOKEN,
    expectedGeneration: backendService.status().generation,
  });
}

/**
 * Restart the Pi runtime owner: stop the Backend (confirmed exit), start it attached again and wait
 * for readiness. The WebUI stays up as its client and serves 503s until the runtime is back.
 */
async function restartBackend() {
  if (!claimServiceRestart()) {
    log("Service restart is already in progress");
    return;
  }
  if (!backendService) {
    restarting = false;
    error("Backend restart requested, but this Host does not run a Backend");
    return;
  }
  log("Restarting the Backend (Pi runtime)...");
  try {
    // Same as WebUI / Host restart: pull first so the rebuild uses the latest sources.
    // Async so hang-watch and the control plane stay responsive during git pull.
    await pullLatestSourcesAsync({ repoRoot: REPO_ROOT, log, error });
    await backendService.stopForRestart();
    await buildBackendWithFallback({ force: true, log, error });
    backendService.start({ attachRuntime: true });
    publishBackendGeneration();
    const clientEnv = backendService.clientEnv();
    const ready = await waitForBackendReady({
      read: () =>
        readBackendHealth({
          baseUrl: clientEnv.LEAFCODE_PI_BACKEND_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
          token: clientEnv.LEAFCODE_PI_BACKEND_TOKEN,
          expectedGeneration: backendService.status().generation ?? "",
        }),
      timeoutMs: BACKEND_START_READY_TIMEOUT_MS,
    });
    if (!ready.ok) {
      error(`Backend did not become ready after the restart (${ready.reason ?? "timeout"})`);
    } else {
      log("Backend restarted and ready");
    }
  } catch (err) {
    error(`Backend restart failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    restarting = false;
  }
}

async function restartWeb() {
  // Backend readiness / Goal Loop / busy refusals are decided in webUiRestartBlockReason
  // before the control plane answers 202. Do not re-check here: a silent return after 202
  // leaves the WebUI reconnect overlay stuck on the still-live SPA. Claim immediately so
  // concurrent handlers cannot interleave another restart during pull/stop.
  if (!claimServiceRestart()) {
    log("Service restart is already in progress");
    return;
  }
  log("Restarting LeafCodePi WebUI...");
  let failed = false;
  try {
    await pullLatestSourcesAsync({ repoRoot: REPO_ROOT, log, error });
    await stopWeb();
    await sleep(STOP_SETTLE_MS);
    // Always rebuild, even without a Pull update. spawnWeb launches the restored
    // previous build on failure without making a second stale-build attempt.
    await spawnWeb({ pull: false, forceBuild: true });
  } catch (err) {
    // The control plane already answered 202 and swallows handler rejections, so an
    // unlogged throw here leaves the WebUI stopped with no trace in host.log.
    failed = true;
    error(`WebUI restart failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    restarting = false;
    await refreshStatusMenu().catch(() => {});
  }
  // A failure after stopWeb leaves nothing serving: fall back to the crash-restart path
  // (bounded by MAX_WEB_RESTARTS) instead of waiting for the operator to notice.
  if (failed && !quitting && !webProc) scheduleWebRestart();
}

/**
 * Spawn a replacement host outside any Kill-On-Job-Close job, wait for our
 * lock to clear, then quit so the new host can take over.
 */
async function restartHost() {
  if (!claimServiceRestart()) return;
  let logFd = null;
  let launcherPath = null;
  let replacementLaunched = false;
  try {
    log("Host restart requested; spawning replacement…");
    await pullLatestSourcesAsync({ repoRoot: REPO_ROOT, log, error });
    if (process.platform !== "win32") {
      const waitProgram = buildHostRestartWaitProgram();
      const logFile = hostStdoutLogFile();
      if (logFile) {
        try {
          logFd = openSync(logFile, "a");
        } catch {
          logFd = null;
        }
      }
      const output = logFd ?? "ignore";
      const child = spawn(
        process.execPath,
        ["-e", waitProgram, LOCK_FILE, process.execPath, fileURLToPath(import.meta.url)],
        {
          detached: true,
          stdio: ["ignore", output, output],
          env: { ...process.env, LEAFCODE_PI_NO_BROWSER: "1", LEAFCODE_PI_REBUILD_SERVICES: "1" },
        },
      );
      await waitForHostRestartChildSpawn(child);
      child.unref();
      replacementLaunched = true;
      log(`Replacement host waiter spawned (PID ${child.pid ?? "unknown"})`);
    } else {
      const name = `leafcode-pi-restart-${randomBytes(6).toString("hex")}.bat`;
      launcherPath = join(tmpdir(), name);
      const launcherExePath = join(REPO_ROOT, "LeafCodePi.exe");
      const startBat = join(REPO_ROOT, "scripts", "start-webui.bat");
      const lines = buildHostRestartScript({
        lockFile: LOCK_FILE,
        launcherExe: existsSync(launcherExePath) ? launcherExePath : null,
        startBat,
      });
      writeFileSync(launcherPath, `${lines.join("\r\n")}\r\n`, "utf8");
      const ps =
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
        `-Arguments @{ CommandLine = 'cmd.exe /c call "${launcherPath}"' }; ` +
        `if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId`;
      const encoded = Buffer.from(ps, "utf16le").toString("base64");
      const out = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      const pid = Number(String(out.stdout ?? "").trim());
      if (out.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
        throw new Error(`WMI launch failed: ${String(out.stderr ?? "").trim() || "no pid"}`);
      }
      replacementLaunched = true;
      log(`Replacement host launcher spawned (WMI PID ${pid})`);
    }
    await quit();
  } catch (err) {
    if (launcherPath && !replacementLaunched) {
      try {
        unlinkSync(launcherPath);
      } catch {
        /* ignore */
      }
    }
    error(`Host restart failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    // Keep the claim only while shutdown is underway; release it after any earlier failure.
    if (!quitting) restarting = false;
  }
}

async function publishStatusWebItem() {
  if (systray != null && procRunning(systray.process)) {
    await systray.sendAction({ type: "update-item", item: statusWebItem });
  }
}

async function refreshStatusMenu() {
  const httpUp = await isHttpUp(`${WEBUI_URL}/api/health`);
  statusWebItem.title = formatWebStatus({
    building: procRunning(webBuildProc),
    running: procRunning(webProc),
    httpUp,
  });
  await publishStatusWebItem();
}

/** Tray clicks are fire-and-forget; a rejected restart must be logged, not crash the Host as an unhandled rejection. */
function trayRequestRestartSafely(target) {
  return trayRequestRestart(target).catch((err) => {
    error(`Tray ${target} restart failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function trayRequestRestart(target) {
  let blocked = null;
  if (target === "webui") blocked = await webUiRestartBlockReason();
  else if (target === "backend") blocked = await backendRestartBlockReason();
  else blocked = (await backendRestartBlockReason()) ?? (await webUiRestartBlockReason());
  if (blocked) {
    error(blocked);
    const previous = statusWebItem.title;
    statusWebItem.title = "再起動を拒否しました";
    await publishStatusWebItem();
    setTimeout(() => {
      if (statusWebItem.title === "再起動を拒否しました") {
        statusWebItem.title = previous;
        void publishStatusWebItem();
      }
    }, 5_000).unref?.();
    return;
  }
  if (target === "webui") await restartWeb();
  else if (target === "backend") await restartBackend();
  else await restartHost();
}

function buildTrayMenu() {
  return {
    icon: TRAY_ICON,
    title: "LeafCodePi",
    tooltip: "LeafCodePi Host",
    items: [
      {
        title: "Open browser",
        tooltip: `Open ${WEBUI_URL}`,
        checked: false,
        enabled: true,
        click: () => openBrowser(WEBUI_URL),
      },
      statusWebItem,
      {
        title: "Restart WebUI",
        tooltip: "Rebuild and restart Next.js (use the previous build on failure)",
        checked: false,
        enabled: true,
        click: () => {
          void trayRequestRestartSafely("webui");
        },
      },
      {
        title: "Restart Backend",
        tooltip: "Rebuild and restart the Pi Backend (ends live sessions; use previous build on failure)",
        checked: false,
        enabled: true,
        click: () => {
          void trayRequestRestartSafely("backend");
        },
      },
      {
        title: "Restart Host",
        tooltip: "Rebuild and restart the tray Host, WebUI, and Backend (ends live sessions)",
        checked: false,
        enabled: true,
        click: () => {
          void trayRequestRestartSafely("host");
        },
      },
      {
        title: "Quit",
        tooltip: "Stop LeafCodePi",
        checked: false,
        enabled: true,
        click: () => {
          void quit();
        },
      },
    ],
  };
}

function wireTrayLifecycle(tray, copyDir, stableTimer) {
  tray.process?.on("exit", (code, signal) => {
    clearTimeout(stableTimer);
    if (quitting || systray !== tray) return;
    error(`Tray helper exited (code=${code ?? "none"}, signal=${signal ?? "none"})`);
    systray = null;
    trayCopyDir = !copyDir;
    scheduleTrayRestart();
  });
}

function scheduleTrayRestart() {
  if (quitting) return;
  if (trayRestarts >= MAX_TRAY_RESTARTS) {
    error(`Tray restart limit reached (${MAX_TRAY_RESTARTS}); continuing without a tray icon`);
    return;
  }
  trayRestarts += 1;
  const delay = Math.min(1000 * trayRestarts, 5000);
  log(`Recreating tray in ${delay}ms (attempt ${trayRestarts}/${MAX_TRAY_RESTARTS})...`);
  setTimeout(() => {
    startTray()
      .then(() => refreshStatusMenu())
      .catch((err) => {
        error(`Tray recreate failed: ${err instanceof Error ? err.message : String(err)}`);
        scheduleTrayRestart();
      });
  }, delay);
}

async function startTray() {
  if (typeof SysTray !== "function") {
    throw new Error(
      `systray2 import failed (got ${typeof SysTrayImport}). Reinstall host deps: cd host && npm install`,
    );
  }
  return withLocalLeafcodeTempEnv(async () => {
    let lastErr;
    for (const copyDir of trayCopyDir ? [true, false] : [false, true]) {
      try {
        const tray = new SysTray({
          menu: buildTrayMenu(),
          debug: false,
          copyDir,
        });
        systray = tray;
        tray.onClick((action) => {
          if (action.item?.click) action.item.click();
        });
        await tray.ready();
        tray.process?.stderr?.on("data", (chunk) => {
          error(`Tray helper: ${String(chunk).trim()}`);
        });
        trayCopyDir = copyDir;
        log(`Tray host ready (copyDir=${copyDir})`);
        const stableTimer = setTimeout(() => {
          if (!quitting && systray === tray) trayRestarts = 0;
        }, RESTART_BUDGET_RESET_MS);
        stableTimer.unref?.();
        wireTrayLifecycle(tray, copyDir, stableTimer);
        return;
      } catch (err) {
        lastErr = err;
        error(`Tray start failed (copyDir=${copyDir}): ${err instanceof Error ? err.message : String(err)}`);
        try {
          await systray?.kill(false);
        } catch {
          /* best effort */
        }
        systray = null;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  });
}

function acquireLock() {
  mkdirSync(DATA_DIR, { recursive: true });
  const processKey = processStartKey(process.pid);
  if (!processKey) throw new Error("Cannot determine host process start key");
  const isOwnerAlive = (owner) => lockOwnerAlive(owner, { getProcessKey: processStartKey });
  const existing = readLock(LOCK_FILE);
  if (existing && isOwnerAlive(existing)) {
    log(`Already running (PID ${existing.pid})`);
    if (shouldOpenBrowser()) openBrowser(WEBUI_URL);
    process.exit(0);
  }
  if (existing) {
    log(`Removing stale lock for PID ${existing.pid}`);
    removeLock(LOCK_FILE);
  } else if (existsSync(LOCK_FILE)) {
    // A lock killed mid-write (or written on a full disk) parses as no owner
    // but still blocks exclusive create. Fail closed unless its owner is known dead.
    // A young file may still be written by a host that just started, so give
    // its creator a short grace period before refusing the unknown owner.
    const owner = awaitLockOwner(LOCK_FILE);
    if (!owner) {
      log("Cannot confirm host.lock owner; refusing to remove it");
      throw new Error("Cannot safely reclaim host.lock");
    }
    if (isOwnerAlive(owner)) {
      log(`Already running (PID ${owner.pid})`);
      if (shouldOpenBrowser()) openBrowser(WEBUI_URL);
      process.exit(0);
    }
    log(`Removing stale unreadable host.lock for PID ${owner.pid}`);
    removeLock(LOCK_FILE);
  }
  try {
    writeLock(LOCK_FILE, process.pid, { processKey });
  } catch {
    const raced = readLock(LOCK_FILE);
    if (raced && isOwnerAlive(raced)) {
      log(`Already running (PID ${raced.pid})`);
      if (shouldOpenBrowser()) openBrowser(WEBUI_URL);
      process.exit(0);
    }
    throw new Error("Could not claim host.lock");
  }
}

async function startControlServer() {
  if (controlServer) return;
  const server = createLlamaControlServer({
    controlPort: CONTROL_PORT,
    onLlamaServerStatus: () => llamaServerService.status(),
    onLlamaServerStart: (config) => llamaServerService.start(config),
    onLlamaServerStop: () => llamaServerService.stop(),
    onRestartWebui: () => restartWeb(),
    onRestartWebuiBlocked: () => webUiRestartBlockReason(),
    onRestartBackend: () => restartBackend(),
    onRestartBackendBlocked: () => backendRestartBlockReason(),
    onRestartHostBlocked: async () => (await backendRestartBlockReason()) ?? (await webUiRestartBlockReason()),
    onRestartHost: () => restartHost(),
    onPiUpdateRead: () => ({
      defaultVersion: DEFAULT_PI_VERSION,
      current: installedPiVersion(WEB_DIR),
      pending: readPiUpdateRequest(DATA_DIR),
      last: readPiUpdateState(DATA_DIR),
    }),
    onPiUpdateRequest: ({ mode }) => {
      // The route validates the mode as well; keep the host entry point safe on its own.
      if (!PI_UPDATE_MODES.includes(mode)) {
        throw Object.assign(new Error("mode must be default or latest"), { status: 400 });
      }
      if (piDepsLockHeld(join(WEB_DIR, PI_DEPS_LOCK_NAME))) {
        throw Object.assign(new Error("Pi synchronization is already in progress"), { status: 409 });
      }
      return { pending: requestPiUpdate(DATA_DIR, mode), restartRequired: true };
    },
    onBrowserConfigRead: () => readBrowserConfig(),
    onBrowserConfigWrite: (patch) => writeBrowserConfig(patch),
    onWebUiAuthRead: () => webUiAuthSettings(),
    onWebUiAuthWrite: (patch) => {
      if (patch.token !== undefined && process.env.LEAFCODE_PI_WEBUI_TOKEN?.trim()) {
        throw Object.assign(
          new Error("LEAFCODE_PI_WEBUI_TOKEN is managed by the environment"),
          { status: 409 },
        );
      }
      const saved = writeWebUiAuthConfig(DATA_DIR, patch);
      setTimeout(() => {
        restartWeb().catch((err) => {
          error(`WebUI auth config restart failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 500);
      return { ...webUiAuthSettings(), restartAccepted: true, enabled: saved.enabled };
    },
    isLocalClientOrigin,
    onOpenExplorer: openProjectInExplorer,
    onTranslationStatus: () => translationService.status(),
    onTranslationStart: () => {
      void translationService.start().catch((err) => {
        error(`Translation service start failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return translationService.status();
    },
    onTranslationStop: () => translationService.stop(),
    onTranslationInstall: () => translationService.install(),
    onTranslationTranslate: async (body) => {
      if (!body || typeof body !== "object" || !Array.isArray(body.texts)) {
        throw new Error("texts must be an array");
      }
      const texts = body.texts;
      if (
        texts.length < 1 ||
        texts.length > 16 ||
        texts.some((text) => typeof text !== "string" || !text.trim())
      ) {
        throw new Error("texts must contain 1-16 non-empty strings");
      }
      if (texts.reduce((sum, text) => sum + text.length, 0) > 16_000) {
        throw new Error("translation request is too large");
      }
      const result = await translationService.translate(texts);
      return {
        translations: result.translations,
        fallbacks: result.fallbacks,
        overridden: result.overridden,
      };
    },
    onTranslationOverride: (body) => {
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.text !== "string" ||
        typeof body.translation !== "string"
      ) {
        throw new Error("text and translation are required");
      }
      return translationService.setOverride(body.text, body.translation);
    },
    onTranslationUnreviewed: (limitRaw) => {
      // Grade fixed-template lines locally first so the paid review prompt
      // only carries entries a model can actually improve.
      translationService.skipTrivialReviews();
      const limit = Number.parseInt(String(limitRaw ?? ""), 10);
      return {
        entries: translationService.unreviewedEntries(
          Number.isFinite(limit) && limit > 0 ? limit : 100,
        ),
      };
    },
    onTranslationReviewResults: (body) => {
      if (!body || typeof body !== "object" || !Array.isArray(body.results)) {
        throw new Error("results must be an array");
      }
      const model =
        typeof body.model === "string" && body.model.trim() ? body.model.trim() : "unknown";
      const updated = translationService.applyReviewResults(body.results, model);
      return { updated };
    },
  });
  try {
    await listenControlServer(server, CONTROL_PORT);
  } catch (err) {
    throw new Error(
      `Host control port ${CONTROL_PORT} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  controlServer = server;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    CONTROL_FILE,
    `${JSON.stringify({ url: `http://127.0.0.1:${CONTROL_PORT}`, port: CONTROL_PORT }, null, 2)}\n`,
    "utf8",
  );
  log(`Host control listening on http://127.0.0.1:${CONTROL_PORT}`);
}

async function quit() {
  if (quitting) return;
  quitting = true;
  log("Quitting...");
  try {
    await closeLoopbackWebUiProxy(loopbackWebUiProxy);
    loopbackWebUiProxy = null;
  } catch {
    /* ignore */
  }
  try {
    await closeControlServer(controlServer);
    controlServer = null;
  } catch {
    /* ignore */
  }
  try {
    const stopped = await translationService.stop();
    if (!stopped) error("Translation service process tree stop could not be confirmed during Host shutdown");
  } catch (err) {
    error(`Translation service stop failed during Host shutdown: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The Backend is this Host's child: it stops with the Host.
    backendService?.stop();
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(CONTROL_FILE)) unlinkSync(CONTROL_FILE);
  } catch {
    /* ignore */
  }
  try {
    await stopWeb();
  } catch {
    /* ignore */
  }
  try {
    if (systray) {
      await Promise.race([
        systray.kill(false).catch(() => {}),
        sleep(2000),
      ]);
    }
  } catch {
    /* ignore */
  }
  removeLock(LOCK_FILE);
  process.exit(0);
}

function onHostExit() {
  if (quitting) return;
  if (webProc?.pid) killTree(webProc.pid);
  removeLock(LOCK_FILE);
}

async function main() {
  acquireLock();
  try {
    logWriter = createLogFileWriter(DATA_DIR);
  } catch (err) {
    removeLock(LOCK_FILE);
    throw err;
  }
  const rebuildServices = consumeHostRestartBuild(process.env);
  log(`LeafCodePi host ${HOST_VERSION} pid=${process.pid}`);
  log(`Binding WebUI on ${WEBUI_HOST}:${WEBUI_PORT} (open ${WEBUI_URL})`);
  if (WEBUI_HOST === "127.0.0.1" && (!process.env.LEAFCODE_PI_HOST || process.env.LEAFCODE_PI_HOST.trim().toLowerCase() === "tailscale")) {
    log("Tailscale IPv4 was not found; bound to 127.0.0.1 and will retry automatically. Connect Tailscale or set LEAFCODE_PI_HOST=0.0.0.0");
  }
  if (WEBUI_AUTH.authRequired && WEBUI_AUTH.token) {
    log(`WebUI remote access requires a password (${webUiAuthPath(DATA_DIR)}). Use /login in the browser.`);
  }

  process.on("SIGINT", () => {
    void quit();
  });
  process.on("SIGTERM", () => {
    void quit();
  });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      void quit();
    });
  } else {
    // Closing the terminal that ran the host would otherwise terminate it
    // without stopping the detached WebUI.
    process.on("SIGHUP", () => {
      void quit();
    });
  }
  process.on("exit", onHostExit);

  try {
    // Pi dependencies change only when settings requested it; otherwise the pinned pair is used
    // as-is. When requested, both installs are prepared and validated before either child starts,
    // and a failed preparation retains the previous pair.
    const piUpdateRequest = consumePiUpdateRequest(DATA_DIR);
    let synchronized = { attempted: false, updated: false, skipped: false, safeToStart: true };
    if (piUpdateRequest) {
      const previousVersion = installedPiVersion(WEB_DIR);
      log(`Pi update requested from settings (${piUpdateRequest.mode})`);
      synchronized = await updatePiBeforeStartup({
        webDir: WEB_DIR, backendDir: join(REPO_ROOT, "backend"), log, error,
        targetVersion: piUpdateRequest.mode === "default" ? DEFAULT_PI_VERSION : null,
      });
      // Record the outcome before refusing startup: the next start surfaces it in settings.
      writePiUpdateState(DATA_DIR, {
        mode: piUpdateRequest.mode,
        requestedAt: piUpdateRequest.requestedAt ?? null,
        finishedAt: Date.now(),
        ok: !synchronized.error && synchronized.safeToStart,
        updated: Boolean(synchronized.updated),
        from: previousVersion,
        version: synchronized.version ?? null,
        error:
          synchronized.error ??
          (synchronized.safeToStart ? null : "Pi dependency synchronization did not finish safely"),
      });
      if (!synchronized.safeToStart) throw new Error("Pi dependency synchronization did not finish safely");
    }
    const piVersion = assertPiDependencyVersions(WEB_DIR, join(REPO_ROOT, "backend"));
    assertInstalledPiVersions(WEB_DIR, piVersion);
    assertInstalledPiVersions(join(REPO_ROOT, "backend"), piVersion);
    if (synchronized.updated) delete process.env.LEAFCODE_PI_SKIP_STALE_REBUILD;
    if (process.env.LEAFCODE_PI_MODE !== "dev" && hasProductionBuild()) {
      let mirrorMatches = false;
      try {
        assertPiDependencyVersions(WEB_MIRROR_DIR, join(REPO_ROOT, "backend"), { requireUnlocked: false });
        assertInstalledPiVersions(WEB_MIRROR_DIR, piVersion);
        mirrorMatches = true;
      } catch { /* a legacy or stale build must not serve a different SDK/AI pair */ }
      if (!mirrorMatches && !rebuildServices) {
        delete process.env.LEAFCODE_PI_SKIP_STALE_REBUILD;
        await buildWeb("stale", { pull: false });
      }
    }
    // Extension sources load directly from the repo, independently of the Web
    // build. Repair missing dependencies even when a restart reuses that build.
    ensureExtensionDependencies(join(REPO_ROOT, "extensions"));
    if (backendService) await buildBackendWithFallback({ force: rebuildServices, log, error });
    await spawnWeb({ forceBuild: rebuildServices, pull: !rebuildServices });
  } catch (err) {
    removeLock(LOCK_FILE);
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    await startControlServer();
  } catch (err) {
    await stopWeb();
    removeLock(LOCK_FILE);
    error(`Control server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const useTray = shouldUseTray();
  if (useTray) {
    try {
      await startTray();
    } catch (err) {
      error(`Tray failed to start: ${err instanceof Error ? err.message : String(err)}`);
      // Windows users expect the tray as the host UI; keep a hard fail there.
      // Linux/macOS continue so a missing AppIndicator / systray helper is not fatal.
      if (process.platform === "win32") {
        await stopWeb();
        removeLock(LOCK_FILE);
        process.exit(1);
      }
      log("Continuing without a tray icon.");
    }
  } else {
    log("Headless mode (no tray). Ctrl+C to quit.");
  }

  // The 5 s maintenance tick must not fail silently: a tray menu that no longer matches the real
  // processes is otherwise invisible until a restart. Failures go to the host log, rate-limited.
  const maintenanceFailures = createRateLimitedReporter({ report: (line) => error(line) });
  const statusRefreshFailures = createConsecutiveFailureTracker(2);
  // The binding check stays on the 5s tick; the tray text (an HTTP health probe) refreshes every 15s,
  // or every tick while a build is running so progress still reads live.
  let maintenanceTick = 0;
  let backendHangProbeInFlight = false;
  setInterval(() => {
    maintenanceTick += 1;
    reconcileWebUiBinding().then(
      () => maintenanceFailures.success("WebUI binding reconcile"),
      (err) => maintenanceFailures.failure("WebUI binding reconcile", err),
    );
    // Every 15s: if the Backend listens but stops answering health, kill and relaunch it.
    // A hung Backend left CLOSE_WAIT sockets and a live PID that served nothing; exit-only
    // restart never fired. Three timed-out probes (~45s) is enough to call it hung.
    // Skip while a probe is already in flight so slow health timeouts cannot stack restarts.
    if (maintenanceTick % 3 === 0 && (restarting || quitting)) {
      backendHangStrikes = 0;
    }
    if (
      maintenanceTick % 3 === 0 &&
      backendService?.status().state === "running" &&
      !restarting &&
      !quitting &&
      !backendHangProbeInFlight
    ) {
      const clientEnv = backendService.clientEnv();
      backendHangProbeInFlight = true;
      void readBackendHealth({
        baseUrl: clientEnv.LEAFCODE_PI_BACKEND_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
        token: clientEnv.LEAFCODE_PI_BACKEND_TOKEN,
        expectedGeneration: backendService.status().generation ?? "",
      }).then((health) => {
        // Another restart claimed the lock while we probed — discard strikes from that window.
        if (restarting || quitting) {
          backendHangStrikes = 0;
          return;
        }
        backendHangStrikes = nextBackendHangStrikes(backendHangStrikes, health);
        if (!backendHangShouldRestart(backendHangStrikes, BACKEND_HANG_STRIKE_LIMIT)) return;
        backendHangStrikes = 0;
        log("Backend health timed out repeatedly; restarting hung Backend...");
        void restartBackend();
      }).catch((err) => maintenanceFailures.failure("Backend hang probe", err))
        .finally(() => {
          backendHangProbeInFlight = false;
        });
    }
    if (maintenanceTick % 3 !== 0 && !procRunning(webBuildProc)) return;
    refreshStatusMenu().then(
      () => {
        statusRefreshFailures.success();
        maintenanceFailures.success("Status menu refresh");
      },
      (err) => {
        maintenanceFailures.failure("Status menu refresh", err);
        if (!statusRefreshFailures.failure()) return;
        statusWebItem.title = formatWebStatus({ degraded: true });
        void publishStatusWebItem().catch((updateError) => {
          maintenanceFailures.failure("Degraded status menu update", updateError);
        });
      },
    );
  }, 5000).unref?.();
  await refreshStatusMenu();

  const ready = await waitUntilReady(`${WEBUI_URL}/api/health`, "LeafCodePi", 120, () => webProc);
  if (ready && shouldOpenBrowser()) openBrowser(WEBUI_URL);
}

if (isThisModuleEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    removeLock(LOCK_FILE);
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
