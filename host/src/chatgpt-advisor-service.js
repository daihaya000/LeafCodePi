/**
 * ChatGPT Advisor setup automation service.
 *
 * Reduces user dependency to two manual steps:
 *   1. Log in to ChatGPT in the dedicated Chrome profile.
 *   2. Approve the C2C Connector in ChatGPT.
 *
 * Everything else is automated: fork extraction, manifest restriction,
 * dedicated Chrome launch, extension ID detection, native host registration,
 * native host launch, and connectivity checks.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restrictToCurrentUser } from "./secure-file.js";
import { stopProcessTreeGracefully as defaultStopProcessTreeGracefully } from "./process-stop.js";

const FORK_PKG = "surf-chatgpt-advisor";
const EXTENSION_VERSION = "2.6.0-restricted";
const CHROME_EXE_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const HOST_NAME = "surf.browser.host";
const NAMED_PIPE = "\\\\.\\pipe\\leafcode-surf";
const STARTUP_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const MAX_CONFIG_PROJECT_ID = 100;

class AdvisorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AdvisorError";
    this.code = code;
    this.status = status;
  }
}

function jsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort cleanup after a successful rename
    }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  const checker = process.platform === "win32" ? "where.exe" : "which";
  try {
    return spawnSync(checker, [command], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

function safeProjectId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONFIG_PROJECT_ID) {
    throw new AdvisorError("INVALID_PROJECT", "projectId is invalid", 400);
  }
  return value;
}

function restrictDir(root) {
  try {
    restrictToCurrentUser(root);
  } catch {
    // best effort
  }
}

/** Restricted manifest: Oracle-required permissions only. */
function restrictedManifest() {
  return {
    manifest_version: 3,
    name: "Surf (LeafCodePi restricted)",
    version: EXTENSION_VERSION,
    description: "LeafCodePi ChatGPT advisor restricted fork",
    options_page: "options/options.html",
    icons: {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_title: "Surf CLI",
      default_icon: {
        "16": "icons/icon-16.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
    background: { service_worker: "service-worker-loader.js", type: "module" },
    content_scripts: [
      {
        matches: ["https://chatgpt.com/*"],
        js: ["content/index.js"],
        run_at: "document_start",
        all_frames: true,
      },
    ],
    permissions: [
      "storage",
      "activeTab",
      "scripting",
      "debugger",
      "tabs",
      "webNavigation",
      "nativeMessaging",
      "cookies",
    ],
    host_permissions: ["https://chatgpt.com/*"],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' https://chatgpt.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://chatgpt.com; font-src 'self' data:;",
    },
    web_accessible_resources: [
      {
        matches: ["https://chatgpt.com/*"],
        resources: ["content/index.js"],
        use_dynamic_url: false,
      },
    ],
  };
}

function resolveChrome() {
  for (const candidate of CHROME_EXE_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new AdvisorError("CHROME_NOT_FOUND", "Chrome is not installed in a known location", 412);
}

function extensionIdFromManifest(manifestPath) {
  // Chrome computes extension IDs from the public key in the manifest, but
  // unpacked extensions without a key get a deterministic ID derived from the
  // absolute path. There is no reliable local computation, so we read the ID
  // from Chrome's Preferences after the first launch.
  return null;
}

/**
 * Chrome derives unpacked-extension IDs from the absolute extension path
 * (Extension::GenerateIdForPath: SHA256 of the normalized path, first 16
 * bytes mapped into [a-p]). Used as a fast fallback before Preferences are
 * flushed; the Preferences read remains authoritative when both disagree.
 */
export function computeExtensionIdFromPath(extensionPath) {
  const normalized = extensionPath.replace(/[\\/]+$/, "");
  const digest = createHash("sha256").update(normalized).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    const value = digest[i];
    id += alphabet[value & 0x0f];
    id += alphabet[(value >> 4) & 0x0f];
  }
  return id;
}

function readExtensionIdFromPreferences(profileDir) {
  const prefs = join(profileDir, "Default", "Preferences");
  if (!existsSync(prefs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(prefs, "utf8"));
    const settings = parsed?.extensions?.settings;
    if (!settings || typeof settings !== "object") return null;
    const entry = Object.values(settings).find(
      (value) =>
        value &&
        typeof value === "object" &&
        typeof value.path === "string" &&
        value.path.includes("surf") &&
        typeof value.manifest === "object" &&
        value.manifest?.name === "Surf (LeafCodePi restricted)",
    );
    if (!entry) return null;
    const id = Object.keys(settings).find(
      (key) => settings[key] === entry && /^[a-p]{32}$/.test(key),
    );
    return id || null;
  } catch {
    return null;
  }
}

export function createChatGptAdvisorService(options) {
  const dataRoot = options.dataDir;
  const repoRoot = options.repoRoot;
  const env = options.env ?? process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const spawnProcess = options.spawn ?? spawn;
  const stopProcessTreeGracefully = options.stopProcessTreeGracefully ?? defaultStopProcessTreeGracefully;
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const hasCommand = options.commandExists ?? commandExists;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const platform = options.platform ?? process.platform;

  const advisorRoot = join(dataRoot, "chatgpt-advisor");
  const forkDir = join(repoRoot, "integrations", FORK_PKG);
  const forkDist = join(forkDir, "dist");
  const configFile = join(advisorRoot, "config.json");
  const runtimeFile = join(advisorRoot, "runtime.json");
  const chromeProfileDir = join(advisorRoot, "chrome-profile");
  const surfStateDir = join(advisorRoot, "surf-state");
  const surfNetworkPath = join(advisorRoot, "surf-network");
  const surfTmp = join(advisorRoot, "tmp");
  const extensionDir = join(advisorRoot, "extension");

  let active = null;
  let chromeProc = null;

  function config() {
    const value = jsonFile(configFile);
    return {
      version: 1,
      enabled: value?.enabled === true,
      activeProjectId:
        typeof value?.activeProjectId === "string" && value.activeProjectId.trim()
          ? value.activeProjectId.trim()
          : null,
      autoPhase:
        value?.autoPhase === "plan" || value?.autoPhase === "plan-review"
          ? value.autoPhase
          : "plan-review",
    };
  }

  function disabled() {
    return env.LEAFCODE_PI_CHATGPT_ADVISOR_DISABLED === "1" || config().enabled !== true;
  }

  function artifactReady() {
    return (
      existsSync(join(forkDist, "manifest.json")) &&
      existsSync(join(forkDist, "service-worker-loader.js")) &&
      existsSync(join(forkDir, "native", "host.cjs")) &&
      existsSync(join(forkDir, "native", "oracle-cli.cjs"))
    );
  }

  function runtime() {
    const value = jsonFile(runtimeFile);
    if (
      !value ||
      !Number.isInteger(value.hostPid) ||
      !Number.isInteger(value.chromePid) ||
      typeof value.extensionId !== "string" ||
      !/^[a-p]{32}$/.test(value.extensionId)
    ) {
      return null;
    }
    return value;
  }

  function clearRuntime() {
    try {
      rmSync(runtimeFile, { force: true });
    } catch {
      // ignore
    }
  }

  function readProject(projectId) {
    const id = safeProjectId(projectId);
    const store = jsonFile(join(dataRoot, "store.json"));
    const project = Array.isArray(store?.projects) ? store.projects.find((entry) => entry?.id === id) : null;
    if (!project || project.archived === true || typeof project.rootPath !== "string" || project.rootPath.trim() === "") {
      throw new AdvisorError("PROJECT_NOT_FOUND", "project was not found", 404);
    }
    if (!existsSync(project.rootPath)) {
      throw new AdvisorError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    let root;
    try {
      root = realpathSync.native(project.rootPath);
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AdvisorError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    if (!resolve(project.rootPath).startsWith(root)) {
      throw new AdvisorError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    return { id, name: typeof project.name === "string" && project.name.trim() ? project.name.trim() : "Untitled", root };
  }

  function prepareDirectories() {
    for (const dir of [advisorRoot, chromeProfileDir, surfStateDir, surfNetworkPath, surfTmp, extensionDir]) {
      mkdirSync(dir, { recursive: true });
      restrictDir(dir);
    }
  }

  /** Extract the pinned fork tarball into integrations/surf-chatgpt-advisor. */
  function extractFork() {
    const tarball = join(repoRoot, "integrations", `${FORK_PKG}.tgz`);
    if (!existsSync(tarball)) {
      throw new AdvisorError("FORK_TARBALL_MISSING", "surf-chatgpt-advisor tarball is missing", 412);
    }
    if (existsSync(forkDir)) rmSync(forkDir, { recursive: true, force: true });
    mkdirSync(forkDir, { recursive: true });
    // Windows tar (bsdtar) misinterprets drive-letter absolute paths; run with
    // cwd = integrations dir and pass both tarball and target as relative.
    const result = spawnSync(
      "tar",
      ["-xzf", `${FORK_PKG}.tgz`, "-C", FORK_PKG, "--strip-components=1"],
      {
        cwd: join(repoRoot, "integrations"),
        stdio: "pipe",
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      throw new AdvisorError("FORK_EXTRACT_FAILED", `fork extraction failed: ${result.stderr || result.stdout || "unknown"}`, 500);
    }
    log("Surf fork extracted");
  }

  /** Apply the restricted manifest to the extension dist. */
  function applyRestrictedManifest() {
    const manifestPath = join(forkDist, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new AdvisorError("FORK_MANIFEST_MISSING", "fork manifest is missing", 412);
    }
    writeJsonAtomic(manifestPath, restrictedManifest());
    // Copy the extension into the advisor-owned extension dir so Chrome loads
    // a stable path and the runtime can verify it.
    if (existsSync(extensionDir)) rmSync(extensionDir, { recursive: true, force: true });
    mkdirSync(extensionDir, { recursive: true });
    for (const entry of ["manifest.json", "service-worker-loader.js", "content", "options", "icons"]) {
      const src = join(forkDist, entry);
      const dest = join(extensionDir, entry);
      if (existsSync(src)) {
        if (statSync(src).isDirectory()) {
          copyDir(src, dest);
        } else {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        }
      }
    }
    restrictDir(extensionDir);
    log("Restricted manifest applied and extension staged");
  }

  function copyDir(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (entry.isDirectory()) copyDir(from, to);
      else if (entry.isFile()) copyFileSync(from, to);
    }
  }

  /** Launch the dedicated Chrome profile with the staged extension. */
  async function openChrome() {
    const chrome = resolveChrome();
    prepareDirectories();
    if (chromeProc && isProcessAlive(chromeProc.pid)) {
      const id = readExtensionIdFromPreferences(chromeProfileDir) || computeExtensionIdFromPath(extensionDir);
      return { alreadyRunning: true, extensionId: id };
    }
    const args = [
      `--user-data-dir=${chromeProfileDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "https://chatgpt.com/",
    ];
    chromeProc = spawnProcess(chrome, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    log(`Chrome launched (pid=${chromeProc.pid})`);
    // Extension IDs for unpacked extensions are derived from the absolute
    // path, so compute immediately; Preferences are the authoritative source
    // once Chrome flushes them.
    const computed = computeExtensionIdFromPath(extensionDir);
    const deadline = now() + STARTUP_TIMEOUT_MS;
    while (now() < deadline) {
      const id = readExtensionIdFromPreferences(chromeProfileDir);
      if (id) {
        log(`Extension ID detected from Preferences: ${id}`);
        return { extensionId: id };
      }
      await wait(READY_POLL_MS);
    }
    log(`Using path-derived extension ID: ${computed}`);
    return { extensionId: computed };
  }

  /** Write the Windows native messaging manifest and register it. */
  function installNativeHost(extensionId) {
    if (!/^[a-p]{32}$/.test(extensionId)) {
      throw new AdvisorError("INVALID_EXTENSION_ID", "extension ID is invalid", 400);
    }
    const nodePath = process.execPath;
    const hostPath = join(forkDir, "native", "host.cjs");
    if (!existsSync(hostPath)) throw new AdvisorError("HOST_MISSING", "native host is missing", 412);
    const wrapperDir = join(advisorRoot, "native-host");
    mkdirSync(wrapperDir, { recursive: true });
    const wrapperBat = join(wrapperDir, "host-wrapper.bat");
    const wrapperContent = `@echo off\r\n"${nodePath}" "${hostPath}" %*\r\n`;
    writeFileSync(wrapperBat, wrapperContent, { encoding: "utf8" });
    restrictDir(wrapperBat);

    const manifestDir = join(advisorRoot, "native-host", "manifest");
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
    const manifest = {
      name: HOST_NAME,
      description: "LeafCodePi ChatGPT Advisor Native Host",
      path: wrapperBat,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };
    writeJsonAtomic(manifestPath, manifest);

    // Windows registers native messaging hosts via the registry.
    const regPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    const reg = spawnSync("reg", ["add", regPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
      stdio: "pipe",
      windowsHide: true,
      encoding: "utf8",
    });
    if (reg.status !== 0) {
      throw new AdvisorError("REGISTRY_FAILED", `native host registry registration failed: ${reg.stderr || "unknown"}`, 500);
    }
    log(`Native host registered for ${extensionId}`);
    return { wrapperBat, manifestPath, extensionId };
  }

  /** Start the Surf native host process with dedicated env. */
  async function startNativeHost() {
    const hostPath = join(forkDir, "native", "host.cjs");
    const nodePath = process.execPath;
    const child = spawnProcess(nodePath, [hostPath], {
      cwd: forkDir,
      env: {
        ...env,
        SURF_SOCKET: NAMED_PIPE,
        SURF_STATE_DIR: surfStateDir,
        SURF_NETWORK_PATH: surfNetworkPath,
        SURF_TMP: surfTmp,
      },
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    active = { hostChild: child };
    child.once("exit", () => {
      if (active?.hostChild === child) active = null;
    });
    log(`Native host started (pid=${child.pid})`);
    return child;
  }

  /** Ping the native host through the socket. */
  async function pingNativeHost(timeoutMs = 5_000) {
    const { default: net } = await import("node:net");
    return new Promise((resolvePing) => {
      const socket = net.createConnection({ path: NAMED_PIPE });
      const timer = setTimeout(() => {
        socket.destroy();
        resolvePing(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolvePing(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolvePing(false);
      });
    });
  }

  async function status(projectId) {
    const common = {
      ok: true,
      enabled: !disabled(),
      artifactReady: artifactReady(),
      chromeAvailable: existsSync(resolveChromeSafe()),
      ready: false,
      state: "disabled",
    };
    if (disabled()) return { ...common, state: "disabled" };
    if (!common.artifactReady) return { ...common, state: "prerequisites_missing" };
    const rt = runtime();
    const chromeRunning = rt && isProcessAlive(rt.chromePid);
    const hostRunning = rt && isProcessAlive(rt.hostPid);
    const socketAlive = chromeRunning && hostRunning ? await pingNativeHost() : false;
    const ready = socketAlive === true;
    if (projectId) {
      try {
        const project = readProject(projectId);
        common.projectId = project.id;
        common.projectName = project.name;
      } catch {
        // project may not exist yet
      }
    }
    return {
      ...common,
      ready,
      state: ready ? "ready" : chromeRunning && hostRunning ? "degraded" : "setup_required",
      extensionId: rt?.extensionId || null,
      chromePid: rt?.chromePid || null,
      hostPid: rt?.hostPid || null,
      profileDir: chromeProfileDir,
    };
  }

  function resolveChromeSafe() {
    try {
      return resolveChrome();
    } catch {
      return null;
    }
  }

  /** Full setup: extract fork, restrict manifest, launch Chrome, detect ID, register native host, start host. */
  async function setup(projectId) {
    if (disabled()) throw new AdvisorError("ADVISOR_DISABLED", "ChatGPT advisor is disabled", 409);
    if (projectId) readProject(projectId); // validate
    if (!artifactReady()) {
      extractFork();
      applyRestrictedManifest();
    }
    const opened = await openChrome();
    const extensionId =
      opened.extensionId ||
      readExtensionIdFromPreferences(chromeProfileDir) ||
      computeExtensionIdFromPath(extensionDir);
    if (!extensionId) throw new AdvisorError("EXTENSION_ID_TIMEOUT", "extension ID was not detected", 504);
    installNativeHost(extensionId);
    await startNativeHost();
    const deadline = now() + STARTUP_TIMEOUT_MS;
    let connected = false;
    while (now() < deadline) {
      connected = await pingNativeHost();
      if (connected) break;
      await wait(READY_POLL_MS);
    }
    if (!connected) throw new AdvisorError("HOST_CONNECT_FAILED", "native host did not become reachable", 504);
    const rt = runtime() || {};
    writeJsonAtomic(runtimeFile, {
      version: 1,
      hostPid: active?.hostChild?.pid || rt.hostPid || 0,
      chromePid: chromeProc?.pid || rt.chromePid || 0,
      extensionId,
      projectId: projectId || null,
    });
    log("ChatGPT advisor setup complete");
    return status(projectId);
  }

  async function stop() {
    if (active?.hostChild) {
      await stopProcessTreeGracefully({ pid: active.hostChild.pid, isAlive: isProcessAlive }).catch(() => undefined);
      active = null;
    }
    const rt = runtime();
    if (rt && isProcessAlive(rt.hostPid)) {
      await stopProcessTreeGracefully({ pid: rt.hostPid, isAlive: isProcessAlive }).catch(() => undefined);
    }
    if (chromeProc && isProcessAlive(chromeProc.pid)) {
      await stopProcessTreeGracefully({ pid: chromeProc.pid, isAlive: isProcessAlive }).catch(() => undefined);
      chromeProc = null;
    } else if (rt && Number.isInteger(rt.chromePid) && isProcessAlive(rt.chromePid)) {
      // chromeProc reference was lost (e.g. host restart); stop from runtime.
      await stopProcessTreeGracefully({ pid: rt.chromePid, isAlive: isProcessAlive }).catch(() => undefined);
    }
    clearRuntime();
    return { ok: true, state: "stopped" };
  }

  async function cleanup(deleteProfile = false) {
    await stop();
    if (deleteProfile) {
      try {
        rmSync(chromeProfileDir, { recursive: true, force: true });
        log("Chrome profile deleted");
      } catch {
        // best effort
      }
    }
    return { ok: true, state: "cleaned" };
  }

  async function setEnabled(enabled) {
    const nextEnabled = enabled === true;
    const current = config();
    writeJsonAtomic(configFile, {
      version: 1,
      enabled: nextEnabled,
      activeProjectId: current.activeProjectId,
      autoPhase: current.autoPhase,
    });
    if (!nextEnabled) await stop().catch(() => undefined);
    return { ok: true, enabled: nextEnabled && env.LEAFCODE_PI_CHATGPT_ADVISOR_DISABLED !== "1" };
  }

  async function setProject(projectId) {
    const id = safeProjectId(projectId);
    readProject(id); // validate
    const current = config();
    writeJsonAtomic(configFile, {
      version: 1,
      enabled: current.enabled,
      activeProjectId: id,
      autoPhase: current.autoPhase,
    });
    return { ok: true, projectId: id };
  }

  async function shutdown() {
    await stop().catch(() => undefined);
  }

  return {
    status,
    setup,
    open: openChrome,
    stop,
    cleanup,
    verify: status,
    setEnabled,
    setProject,
    shutdown,
    _internals: {
      restrictedManifest,
      readExtensionIdFromPreferences,
      computeExtensionIdFromPath,
      installNativeHost,
      extractFork,
      applyRestrictedManifest,
      NAMED_PIPE,
      prepareDirectories,
    },
  };
}
