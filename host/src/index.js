import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SysTrayImport from "systray2";
import { bindHost, dataDir, DEFAULT_HOST_CONTROL_PORT, DEFAULT_LLAMA_SERVER_PORT, DEFAULT_WEBUI_PORT, readPort, shouldOpenBrowser as envAllowsBrowser, shouldUseTray, webUiUrl } from "./config.js";
import { readBrowserConfig, writeBrowserConfig } from "./browser-config.js";
import { isThisModuleEntrypoint } from "./entry.js";
import { createLlamaControlServer, closeControlServer, listenControlServer } from "./llama-control-server.js";
import { createLlamaServerService } from "./llama-server-service.js";
import { pidAlive, readLock, removeLock, writeLock } from "./lock.js";
import { createLogFileWriter, formatLogLine } from "./log-file.js";
import { getListeningPids, getPortListenerStatus } from "./port-scanner.js";
import { hardKillTree, stopProcessTreeGracefully } from "./process-stop.js";
import { buildHostRestartScript } from "./host-restart.js";
import { autoUpdatePiInBackground } from "./pi-update.js";
import { createTranslationService } from "./translation-service.js";
import { withLocalLeafcodeTempEnv } from "./tray-temp.js";
import {
  ensureWebUiAuth,
  isLoopbackBind,
  readWebUiAuthConfig,
  webUiAuthPath,
  writeWebUiAuthConfig,
} from "./webui-auth.js";
import {
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
import { ensureBuildDependencies } from "../../scripts/build-web.mjs";

const SysTray =
  SysTrayImport?.default?.default || SysTrayImport?.default || SysTrayImport;

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
const MAX_WEB_RESTARTS = 3;
const MAX_TRAY_RESTARTS = 3;

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

function openProjectInExplorer(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [path], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
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
  trayEnabled: shouldUseTray(),
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

const iconData = JSON.parse(readFileSync(join(__dirname, "icon.json"), "utf8"));
const TRAY_ICON = iconData.base64;

const logWriter = createLogFileWriter(DATA_DIR);

/** @type {import("node:child_process").ChildProcess | null} */
let webProc = null;
let webBuildProc = null;
let webBuildPromise = null;
/** @type {import("systray2").default | null} */
let systray = null;
let quitting = false;
let webRestarts = 0;
let trayRestarts = 0;
let restarting = false;
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

function log(text) {
  const line = formatLogLine({ ts: Date.now(), source: "host", level: "log", text });
  console.log(`[LeafCodePi] ${text}`);
  logWriter.write({ ts: Date.now(), source: "host", level: "log", text });
  return line;
}

function error(text) {
  console.error(`[LeafCodePi] ERROR ${text}`);
  logWriter.write({ ts: Date.now(), source: "host", level: "error", text });
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
    logWriter.write({ ts: Date.now(), source: label, level: "log", text: String(chunk) });
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
    logWriter.write({ ts: Date.now(), source: label, level: "error", text: String(chunk) });
  });
}

function runNodeScript(args, options) {
  return spawn(process.execPath, args, {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "pipe",
    ...options,
  });
}

function installWebIfNeeded() {
  if (!existsSync(join(WEB_DIR, "node_modules", "next"))) {
    log("Installing web dependencies...");
    const result = spawnSync(npmCmd(), ["install"], {
      cwd: WEB_DIR,
      shell: true,
      windowsHide: true,
      // npm changes process.title on Windows. Pipe its output so it cannot
      // replace the LeafCodePi launcher title on the shared console.
      stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (process.platform === "win32") writeCapturedOutput(result);
    if (result.status !== 0) {
      throw new Error(`npm install (web) exited ${result.status}`);
    }
  }
}

function buildWeb(reason = "missing") {
  if (webBuildPromise) return webBuildPromise;

  const promise = new Promise((resolve, reject) => {
    const reasonText =
      reason === "stale"
        ? "Production LeafCodePi build is stale (sources newer than BUILD_ID); rebuilding…"
        : "Production LeafCodePi build is missing; rebuilding…";
    log(reasonText);
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

async function spawnWeb() {
  installWebIfNeeded();
  let hasBuild = hasProductionBuild();
  const skipStaleBuild = process.env.LEAFCODE_PI_SKIP_STALE_REBUILD === "1";
  const actualBuildStale = hasBuild && isWebBuildStale(WEB_DIR, webDistDir());
  const buildStale = !skipStaleBuild && actualBuildStale;
  if (skipStaleBuild && actualBuildStale) {
    log("Skipping stale production rebuild during host replacement; serving the existing build");
  }
  let plan = getWebLaunchPlan(process.env.LEAFCODE_PI_MODE, hasBuild, buildStale);
  if (plan.needsBuild) {
    const rebuildReason = hasBuild && buildStale ? "stale" : "missing";
    try {
      await buildWeb(rebuildReason);
    } catch (err) {
      hasBuild = hasProductionBuild();
      const stillStaleAfterFailure = hasBuild && isWebBuildStale(WEB_DIR, webDistDir());
      const failureAction = staleRebuildFailureAction({
        rebuildReason,
        hasBuild,
        stillStale: stillStaleAfterFailure,
        mode: process.env.LEAFCODE_PI_MODE,
      });
      if (failureAction === "fail") {
        throw new Error(
          `Stale production rebuild failed and sources are still newer than the build (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (failureAction === "continue-stale") {
        error(
          `Stale rebuild failed; continuing with the existing production build (${err instanceof Error ? err.message : String(err)})`,
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
  // Production serves the mirrored project; dev keeps running from the repo.
  const projectDir = useProd ? WEB_MIRROR_DIR : WEB_DIR;
  const args = useProd
    ? [nextBin(projectDir), "start", "--hostname", WEBUI_HOST, "--port", String(WEBUI_PORT)]
    : [nextBin(projectDir), "dev", "--hostname", WEBUI_HOST, "--port", String(WEBUI_PORT)];
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
    },
  });
  webProc = child;
  pipeChild("webui", child);
  child.on("error", (err) => error(`WebUI spawn error: ${err.message}`));
  child.on("close", (code, signal) => {
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
  for (let i = 0; i < 20; i += 1) {
    if (!pidAlive(child.pid)) break;
    await sleep(100);
  }
}

/**
 * Goal Loop runs inside the WebUI process, so restarting Next.js ends its Pi
 * session and pauses the loop mid-turn. Ask the WebUI first and refuse while a
 * loop is live. An unreachable WebUI has no loop left to protect, so probe
 * failures fall through and keep restart available for recovery.
 */
async function webUiRestartBlockReason() {
  try {
    const response = await fetch(`${WEBUI_URL}/api/goal-loop/active`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      headers:
        WEBUI_AUTH.authRequired && WEBUI_AUTH.token
          ? { authorization: `Bearer ${WEBUI_AUTH.token}` }
          : {},
    });
    if (!response.ok) return null;
    const body = await response.json();
    const active = Number(body?.active) || 0;
    if (active <= 0) return null;
    return `Goal Loop が ${active} 件実行中のため WebUI の再起動を拒否しました。ループを停止・完了してから再試行してください。`;
  } catch {
    return null;
  }
}

async function restartWeb() {
  if (restarting) {
    log("Service restart is already in progress");
    return;
  }
  const blocked = await webUiRestartBlockReason();
  if (blocked) {
    error(blocked);
    return;
  }
  restarting = true;
  log("Restarting LeafCodePi WebUI...");
  try {
    await stopWeb();
    await sleep(400);
    await spawnWeb();
  } finally {
    restarting = false;
    await refreshStatusMenu();
  }
}

/**
 * Spawn a replacement host outside any Kill-On-Job-Close job, wait for our
 * lock to clear, then quit so the new host can take over.
 */
async function restartHost() {
  log("Host restart requested; spawning replacement…");
  if (process.platform !== "win32") {
    const waitScript = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const [lock, executable, entry] = process.argv.slice(1);",
      "const wait = () => { if (fs.existsSync(lock)) setTimeout(wait, 100); else { const child = spawn(executable, [entry], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); } };",
      "wait();",
    ].join(" ");
    const child = spawn(
      process.execPath,
      ["-e", waitScript, LOCK_FILE, process.execPath, fileURLToPath(import.meta.url)],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, LEAFCODE_PI_NO_BROWSER: "1" },
      },
    );
    child.once("error", (err) => error(`Host restart failed: ${err.message}`));
    child.unref();
    log(`Replacement host waiter spawned (PID ${child.pid ?? "unknown"})`);
    await quit();
    return;
  }

  const name = `leafcode-pi-restart-${randomBytes(6).toString("hex")}.bat`;
  const launcherPath = join(tmpdir(), name);
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
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    const pid = Number(String(out.stdout ?? "").trim());
    if (out.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`WMI launch failed: ${String(out.stderr ?? "").trim() || "no pid"}`);
    }
    log(`Replacement host launcher spawned (WMI PID ${pid})`);
    await quit();
  } catch (err) {
    delete process.env.LEAFCODE_PI_SKIP_STALE_REBUILD;
    error(`Host restart failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      unlinkSync(launcherPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function refreshStatusMenu() {
  const httpUp = await isHttpUp(`${WEBUI_URL}/api/health`);
  statusWebItem.title = formatWebStatus({
    building: procRunning(webBuildProc),
    running: procRunning(webProc),
    httpUp,
  });
  if (systray != null && procRunning(systray.process)) {
    systray.sendAction({ type: "update-item", item: statusWebItem });
  }
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
        tooltip: "Restart Next.js",
        checked: false,
        enabled: true,
        click: () => {
          void restartWeb();
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

function wireTrayLifecycle() {
  if (!systray) return;
  systray.process?.on("exit", () => {
    if (quitting) return;
    error("Tray helper exited");
    systray = null;
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
    for (const copyDir of [true, false]) {
      try {
        systray = new SysTray({
          menu: buildTrayMenu(),
          debug: false,
          copyDir,
        });
        systray.onClick((action) => {
          if (action.item?.click) action.item.click();
        });
        await systray.ready();
        log(`Tray host ready (copyDir=${copyDir})`);
        wireTrayLifecycle();
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
  const existing = readLock(LOCK_FILE);
  if (existing && pidAlive(existing.pid)) {
    log(`Already running (PID ${existing.pid})`);
    if (shouldOpenBrowser()) openBrowser(WEBUI_URL);
    process.exit(0);
  }
  if (existing) {
    log(`Removing stale lock for PID ${existing.pid}`);
    removeLock(LOCK_FILE);
  }
  try {
    writeLock(LOCK_FILE);
  } catch {
    const raced = readLock(LOCK_FILE);
    if (raced && pidAlive(raced.pid)) {
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
    onRestartHost: () => restartHost(),
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
    onOpenExplorer: process.platform === "win32" ? openProjectInExplorer : undefined,
    onTranslationStatus: () => translationService.status(),
    onTranslationStart: () => {
      translationService.start();
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
    await closeControlServer(controlServer);
    controlServer = null;
  } catch {
    /* ignore */
  }
  try {
    translationService.stop();
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
  log(`LeafCodePi host ${HOST_VERSION} pid=${process.pid}`);
  log(`Binding WebUI on ${WEBUI_HOST}:${WEBUI_PORT} (open ${WEBUI_URL})`);
  if (WEBUI_HOST === "127.0.0.1" && (!process.env.LEAFCODE_PI_HOST || process.env.LEAFCODE_PI_HOST.trim().toLowerCase() === "tailscale")) {
    log("Tailscale IPv4 was not found; bound to 127.0.0.1. Connect Tailscale or set LEAFCODE_PI_HOST=0.0.0.0");
  }
  if (WEBUI_AUTH.authRequired && WEBUI_AUTH.token) {
    log(`WebUI remote access requires a token (${webUiAuthPath(DATA_DIR)}). Use /login in the browser.`);
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
  }
  process.on("exit", onHostExit);

  try {
    await spawnWeb();
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
      await stopWeb();
      removeLock(LOCK_FILE);
      error(`Tray failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    log("Headless mode (no tray). Ctrl+C to quit.");
  }

  setInterval(() => {
    refreshStatusMenu().catch(() => {});
  }, 5000).unref?.();
  await refreshStatusMenu();

  const ready = await waitUntilReady(`${WEBUI_URL}/api/health`, "LeafCodePi", 120, () => webProc);
  // `npm update` のネットワーク待ちで起動を止めない。UI 応答後に裏で更新する。
  autoUpdatePiInBackground({ webDir: WEB_DIR, log, error });
  if (ready && shouldOpenBrowser()) openBrowser(WEBUI_URL);
}

if (isThisModuleEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    removeLock(LOCK_FILE);
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
