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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stopProcessTreeGracefully as defaultStopProcessTreeGracefully } from "./process-stop.js";

const FORK_PKG = "surf-chatgpt-advisor";
// Chrome rejects a manifest whose version is not 1-4 dot-separated integers,
// so the "restricted" marker belongs in version_name, not version.
const EXTENSION_VERSION = "2.6.0";
const EXTENSION_VERSION_NAME = "2.6.0-leafcodepi-restricted";
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
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeJsonOnce(file, payload);
  } catch (error) {
    // A stripped-inheritance directory leaves files with an empty DACL, so the
    // first write fails with EPERM. Restore inherited ACLs once and retry.
    if (error?.code !== "EPERM" || !repairAcl(dirname(file))) {
      throw new Error(`${error?.code || "WRITE_FAILED"}: failed to write ${file}: ${error?.message || "unknown"}`);
    }
    try {
      writeJsonOnce(file, payload);
    } catch (retryError) {
      throw new Error(
        `${retryError?.code || "WRITE_FAILED"}: failed to write ${file} after ACL repair: ${retryError?.message || "unknown"}`,
      );
    }
  }
}

function writeJsonOnce(file, payload) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    // Windows ignores the POSIX mode and can reject it outright, so only pass
    // it where it means something.
    writeFileSync(temp, payload, process.platform === "win32" ? { encoding: "utf8" } : { encoding: "utf8", mode: 0o600 });
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

/**
 * Restore inherited ACLs under `root`.
 *
 * An earlier build locked these directories down with `icacls /inheritance:r`,
 * which leaves files created inside with an empty DACL: reading, renaming and
 * deleting them then fail with EPERM and the advisor can never be enabled.
 * Resetting to inherited permissions is the only way out, and it is safe here
 * because the tree lives under the per-user %APPDATA% root.
 */
function repairAcl(root) {
  if (process.platform !== "win32") return false;
  try {
    return spawnSync("icacls", [root, "/reset", "/T", "/C", "/Q"], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0;
  } catch {
    return false;
  }
}

/** Restricted manifest: Oracle-required permissions only. */
function restrictedManifest() {
  return {
    manifest_version: 3,
    name: "Surf (LeafCodePi restricted)",
    version: EXTENSION_VERSION,
    version_name: EXTENSION_VERSION_NAME,
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

/**
 * Locate a Chromium that can still load an unpacked extension.
 *
 * Verified on this machine: Chrome 151 and Edge silently ignore
 * `--load-extension` (Chrome removed the switch), so installed Chrome cannot
 * host the advisor extension. Playwright's bundled Chromium and Chrome for
 * Testing keep the switch, so those are preferred and the stable browsers are
 * not used at all -- falling back to them would look like it worked while the
 * extension never loads.
 */
export function resolveExtensionCapableBrowser(env = process.env) {
  const roots = [];
  if (env.LOCALAPPDATA) {
    roots.push(join(env.LOCALAPPDATA, "ms-playwright"));
    roots.push(join(env.LOCALAPPDATA, "Chrome for Testing"));
  }
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^chromium-\d+$|^chrome-win/.test(entry.name)) continue;
      for (const layout of [join("chrome-win64", "chrome.exe"), join("chrome-win", "chrome.exe"), "chrome.exe"]) {
        const exe = join(root, entry.name, layout);
        if (existsSync(exe)) {
          found.push({ exe, revision: Number(entry.name.match(/(\d+)/)?.[1] ?? 0) });
          break;
        }
      }
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.revision - a.revision);
  return found[0].exe;
}

function resolveChrome(env = process.env) {
  const exe = resolveExtensionCapableBrowser(env);
  if (exe) return exe;
  throw new AdvisorError(
    "BROWSER_NOT_FOUND",
    "no Chromium that supports --load-extension was found; installed Chrome and Edge ignore the switch. Install Playwright's Chromium (npx playwright install chromium) or Chrome for Testing.",
    412,
  );
}

/**
 * Reproduce Chrome's Extension::GenerateIdForPath for unpacked extensions.
 *
 * Chrome hashes the raw bytes of the absolute path -- on Windows that is the
 * UTF-16LE representation with the drive letter upper-cased -- takes the first
 * 16 bytes of the SHA-256, hex-encodes them and maps '0'-'9'/'A'-'F' onto
 * 'a'-'p'. Hex encoding emits the high nibble first, so nibble order matters.
 */
export function computeExtensionIdFromPath(extensionPath, platform = process.platform) {
  let normalized = extensionPath.replace(/[\\/]+$/, "");
  let input;
  if (platform === "win32") {
    if (/^[a-z]:/.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
    input = Buffer.from(normalized, "utf16le");
  } else {
    input = Buffer.from(normalized, "utf8");
  }
  const digest = createHash("sha256").update(input).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    id += alphabet[(digest[i] >> 4) & 0x0f];
    id += alphabet[digest[i] & 0x0f];
  }
  return id;
}

/**
 * Confirm the extension is actually running.
 *
 * Extensions loaded from the command line are not written to the profile's
 * Preferences, so the only reliable signal is a live DevTools target under
 * `chrome-extension://<id>/`. Chrome writes the chosen port to
 * DevToolsActivePort in the profile directory when launched with port 0.
 */
async function isExtensionLoaded(profileDir, extensionId) {
  const portFile = join(profileDir, "DevToolsActivePort");
  if (!existsSync(portFile)) return false;
  const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port <= 0) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const targets = await response.json();
    return (
      Array.isArray(targets) &&
      targets.some((target) => typeof target?.url === "string" && target.url.startsWith(`chrome-extension://${extensionId}/`))
    );
  } catch {
    return false;
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
      // Do not lock directories down: later rmSync of extensionDir/Chrome
      // profile would fail with EPERM because inherited ACLs propagate to
      // created children and icacls inheritance removal breaks the directory's
      // own delete permission chain. Secure the state files individually instead.
    }
  }

  /** Extract the pinned fork tarball into integrations/surf-chatgpt-advisor. */
  function extractFork() {
    const tarball = join(repoRoot, "integrations", `${FORK_PKG}.tgz`);
    if (!existsSync(tarball)) {
      throw new AdvisorError("FORK_TARBALL_MISSING", "surf-chatgpt-advisor tarball is missing", 412);
    }
    const tmpDir = `${forkDir}.${process.pid}.${Date.now()}`;
    // If a previous extraction is locked, stage into a fresh temp dir and swap.
    if (existsSync(forkDir)) {
      try {
        rmSync(forkDir, { recursive: true, force: true });
      } catch {
        // best effort; extraction into tmpDir will still produce a usable forkDir after rename
      }
    }
    mkdirSync(tmpDir, { recursive: true });
    // Windows tar (bsdtar) misinterprets drive-letter absolute paths; run with
    // cwd = integrations dir and pass both tarball and target as relative.
    const result = spawnSync(
      "tar",
      ["-xzf", `${FORK_PKG}.tgz`, "-C", basename(tmpDir), "--strip-components=1"],
      {
        cwd: join(repoRoot, "integrations"),
        stdio: "pipe",
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      throw new AdvisorError("FORK_EXTRACT_FAILED", `fork extraction failed: ${result.stderr || result.stdout || "unknown"}`, 500);
    }
    if (existsSync(forkDir)) {
      try { rmSync(forkDir, { recursive: true, force: true }); } catch {}
    }
    renameSync(tmpDir, forkDir);
    log("Surf fork extracted");
  }

  /** Stage the extension with the restricted manifest applied. */
  function applyRestrictedManifest() {
    if (!existsSync(join(forkDist, "manifest.json"))) {
      throw new AdvisorError("FORK_MANIFEST_MISSING", "fork manifest is missing", 412);
    }
    // Copy the whole dist: an allow-list silently drops files the bundle needs
    // (service-worker-loader.js imports ./service-worker/index.js, so omitting
    // that directory leaves Chrome unable to load the extension at all).
    // Permissions are restricted by the manifest, not by which files ship.
    if (existsSync(extensionDir)) rmSync(extensionDir, { recursive: true, force: true });
    copyDir(forkDist, extensionDir);
    const manifest = restrictedManifest();
    // Chrome only reports manifest errors in a modal dialog the host never
    // sees, so validate the fields it rejects outright before staging.
    if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version)) {
      throw new AdvisorError("MANIFEST_INVALID", `manifest version ${manifest.version} is not 1-4 dot-separated integers`, 500);
    }
    writeJsonAtomic(join(extensionDir, "manifest.json"), manifest);
    const loader = join(extensionDir, "service-worker-loader.js");
    if (existsSync(loader)) {
      const target = readFileSync(loader, "utf8").match(/['"](\.\/[^'"]+)['"]/)?.[1];
      if (target && !existsSync(join(extensionDir, target))) {
        throw new AdvisorError("FORK_INCOMPLETE", `service worker entry ${target} is missing from the staged extension`, 500);
      }
    }
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

  /** Launch the dedicated browser profile with the staged extension. */
  async function openChrome() {
    const chrome = resolveChrome(env);
    prepareDirectories();
    // The ID is derived from the extension's absolute path by the same
    // algorithm Chrome uses, so it is known before launch.
    const extensionId = computeExtensionIdFromPath(extensionDir, platform);
    if (chromeProc && isProcessAlive(chromeProc.pid)) {
      return { alreadyRunning: true, extensionId };
    }
    const args = [
      `--user-data-dir=${chromeProfileDir}`,
      `--load-extension=${extensionDir}`,
      // Port 0 lets the browser pick a free localhost port and write it to
      // DevToolsActivePort; it is only used to confirm the extension loaded.
      "--remote-debugging-port=0",
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
    log(`Browser launched: ${chrome} (pid=${chromeProc.pid})`);

    const deadline = now() + STARTUP_TIMEOUT_MS;
    while (now() < deadline) {
      if (await isExtensionLoaded(chromeProfileDir, extensionId)) {
        log(`Extension confirmed loaded: ${extensionId}`);
        return { extensionId };
      }
      await wait(READY_POLL_MS);
    }
    throw new AdvisorError(
      "EXTENSION_NOT_LOADED",
      `the browser did not load the advisor extension (${extensionId}). Chrome 137+ and Edge ignore --load-extension; use Playwright's Chromium or Chrome for Testing.`,
      504,
    );
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
    // The browser -- not this service -- spawns the native host, so it does not
    // inherit our environment. The dedicated socket and state paths have to be
    // baked into the wrapper or the host would fall back to the shared
    // //./pipe/surf and the global Surf state directory.
    const wrapperContent = [
      "@echo off",
      `set "SURF_SOCKET=${NAMED_PIPE}"`,
      `set "SURF_STATE_DIR=${surfStateDir}"`,
      `set "SURF_NETWORK_PATH=${surfNetworkPath}"`,
      `set "SURF_TMP=${surfTmp}"`,
      `"${nodePath}" "${hostPath}" %*`,
      "",
    ].join("\r\n");
    writeFileSync(wrapperBat, wrapperContent, { encoding: "utf8" });

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
    let reg;
    try {
      reg = spawnSync("reg", ["add", regPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
        stdio: "pipe",
        windowsHide: true,
        encoding: "utf8",
      });
    } catch (error) {
      throw new AdvisorError("REGISTRY_FAILED", `native host registry registration failed: ${error?.message || "unknown"}`, 500);
    }
    if (reg.status !== 0) {
      const detail = reg.stderr || reg.stdout || `exit code ${reg.status}`;
      throw new AdvisorError("REGISTRY_FAILED", `native host registry registration failed: ${detail}`, 500);
    }
    log(`Native host registered for ${extensionId}`);
    return { wrapperBat, manifestPath, extensionId };
  }

  /**
   * The native host is deliberately not started here.
   *
   * host.cjs is a native messaging host: it shuts down as soon as stdin ends,
   * so spawning it with stdio "ignore" kills it immediately and the socket is
   * never created. Only the browser may start it, via connectNative() from the
   * extension, which is why setup waits for the socket instead.
   */

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
      chromeAvailable: resolveChromeSafe() !== null,
      ready: false,
      state: "disabled",
    };
    if (disabled()) return { ...common, state: "disabled" };
    if (!common.artifactReady) return { ...common, state: "prerequisites_missing" };
    const rt = runtime();
    const chromeRunning = rt && isProcessAlive(rt.chromePid);
    // The browser owns the native host, so socket reachability is the only
    // signal that the advisor is actually usable.
    const ready = chromeRunning ? await pingNativeHost() : false;
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
      state: ready ? "ready" : chromeRunning ? "degraded" : "setup_required",
      extensionId: rt?.extensionId || null,
      chromePid: rt?.chromePid || null,
      profileDir: chromeProfileDir,
    };
  }

  function resolveChromeSafe() {
    try {
      return resolveChrome(env);
    } catch {
      return null;
    }
  }

  /** Full setup: extract fork, restrict manifest, launch Chrome, detect ID, register native host, start host. */
  async function setup(projectId) {
    if (disabled()) throw new AdvisorError("ADVISOR_DISABLED", "ChatGPT advisor is disabled", 409);
    if (projectId) readProject(projectId); // validate
    try {
      log(`setup: start projectId=${projectId || "none"}`);
      if (!artifactReady()) {
        log("setup: extracting fork");
        extractFork();
        log("setup: applying restricted manifest");
        applyRestrictedManifest();
      }
      log("setup: launching dedicated Chrome");
      const { extensionId } = await openChrome();
      log(`setup: extensionId=${extensionId}`);
      log("setup: installing native host");
      installNativeHost(extensionId);
      // Chrome starts the native host when the extension calls connectNative,
      // so wait for the socket rather than spawning it here.
      log("setup: waiting for the extension to start the native host");
      const deadline = now() + STARTUP_TIMEOUT_MS;
      let connected = false;
      while (now() < deadline) {
        connected = await pingNativeHost();
        if (connected) break;
        await wait(READY_POLL_MS);
      }
      if (!connected) {
        throw new AdvisorError(
          "HOST_CONNECT_FAILED",
          "the extension did not start the native host; open the extension in the dedicated browser and confirm it is enabled",
          504,
        );
      }
      const rt = runtime() || {};
      writeJsonAtomic(runtimeFile, {
        version: 1,
        chromePid: chromeProc?.pid || rt.chromePid || 0,
        extensionId,
        projectId: projectId || null,
      });
      log("ChatGPT advisor setup complete");
      return status(projectId);
    } catch (error) {
      const code = error?.code || "SETUP_FAILED";
      const message = error?.message || String(error);
      log(`setup failed at ${code}: ${message}`);
      throw new AdvisorError(code, message, error?.status || 500);
    }
  }

  async function stop() {
    // Stopping the browser also stops the native host it spawned.
    const rt = runtime();
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
      isExtensionLoaded,
      computeExtensionIdFromPath,
      installNativeHost,
      extractFork,
      applyRestrictedManifest,
      NAMED_PIPE,
      prepareDirectories,
    },
  };
}
