import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { stopProcessTreeGracefully as defaultStopProcessTreeGracefully } from "./process-stop.js";

const C2C_DIR_NAME = "c2c";
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 200;
const MAX_PROJECT_ID_LENGTH = 100;

export class ChatGptBridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ChatGptBridgeError";
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

function workspaceId(root) {
  const normalized = process.platform === "win32" || process.platform === "darwin" ? root.toLowerCase() : root;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function safeProjectId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_ID_LENGTH) {
    throw new ChatGptBridgeError("INVALID_PROJECT", "projectId is invalid", 400);
  }
  return value;
}

export function createChatGptBridgeService(options) {
  const dataRoot = options.dataDir;
  const repoRoot = options.repoRoot;
  const env = options.env ?? process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const spawnProcess = options.spawn ?? spawn;
  const stopProcessTreeGracefully = options.stopProcessTreeGracefully ?? defaultStopProcessTreeGracefully;
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const hasCommand = options.commandExists ?? commandExists;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const c2cRoot = join(dataRoot, C2C_DIR_NAME);
  const configFile = join(c2cRoot, "config.json");
  const artifactRoot = join(repoRoot, "integrations", "codex-with-chatgpt");
  const artifactPackage = join(artifactRoot, "package.json");
  const artifactBin = join(artifactRoot, "bin", "c2c.js");
  const artifactDist = join(artifactRoot, "dist", "cli", "index.js");
  const artifactLock = join(artifactRoot, "package-lock.json");

  let active = null;
  let startInFlight = null;

  function config() {
    const value = jsonFile(configFile);
    return { version: 1, enabled: value?.enabled === true };
  }

  function disabled() {
    return env.LEAFCODE_PI_C2C_DISABLED === "1" || config().enabled !== true;
  }

  function artifactReady() {
    return existsSync(artifactRoot) && existsSync(artifactPackage) && existsSync(artifactBin) && existsSync(artifactDist) && existsSync(artifactLock);
  }

  function runtimeFile(id) {
    return join(c2cRoot, "runtime", `${id}.json`);
  }

  function readRuntime(id) {
    const value = jsonFile(runtimeFile(id));
    if (
      !value ||
      value.workspaceId !== id ||
      !Number.isInteger(value.pid) ||
      !Number.isInteger(value.port) ||
      typeof value.adminToken !== "string" ||
      value.adminToken.length < 16
    ) {
      return null;
    }
    return value;
  }

  function clearRuntime(id) {
    try {
      rmSync(runtimeFile(id), { force: true });
    } catch {
      // ignore stale-state cleanup failures
    }
  }

  function readProject(projectId) {
    const id = safeProjectId(projectId);
    const store = jsonFile(join(dataRoot, "store.json"));
    const project = Array.isArray(store?.projects) ? store.projects.find((entry) => entry?.id === id) : null;
    if (!project || project.archived === true || typeof project.rootPath !== "string" || project.rootPath.trim() === "") {
      throw new ChatGptBridgeError("PROJECT_NOT_FOUND", "project was not found", 404);
    }
    if (!existsSync(project.rootPath)) {
      throw new ChatGptBridgeError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    let root;
    try {
      root = realpathSync.native(project.rootPath);
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ChatGptBridgeError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    // A registered project must be an absolute canonical directory. This also
    // prevents a malformed store entry from being interpreted relative to Host.
    if (!isAbsolute(project.rootPath)) {
      throw new ChatGptBridgeError("PROJECT_UNAVAILABLE", "project is not available", 409);
    }
    return {
      id,
      name: typeof project.name === "string" && project.name.trim() ? project.name.trim() : "Untitled",
      root,
      workspaceId: workspaceId(root),
    };
  }

  async function adminRequest(runtime, method, route, timeoutMs = 5_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${runtime.adminToken}` },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new ChatGptBridgeError("BRIDGE_REQUEST_FAILED", "Bridge request failed", 502);
      return body;
    } catch (error) {
      if (error instanceof ChatGptBridgeError) throw error;
      throw new ChatGptBridgeError("BRIDGE_UNAVAILABLE", "Bridge is unavailable", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  function publicUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) {
        return null;
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  function statusFromInfo(project, info, common) {
    const tunnelUrl = publicUrl(info.publicUrl);
    const tunnelRunning = info.tunnel?.running === true && tunnelUrl !== null;
    const connected = Number(info.tokenCount) > 0;
    const verifiedAt = typeof info.verifiedAt === "string" ? info.verifiedAt : null;
    const verified = verifiedAt !== null;
    const state = verified ? "verified" : connected ? "connected" : info.pairingActive ? "pairing" : "starting";
    return {
      ok: true,
      ...common,
      projectId: project.id,
      projectName: project.name,
      state,
      connected,
      verified,
      verifiedAt,
      publicUrl: tunnelRunning ? tunnelUrl : null,
      connectionUrl: tunnelRunning ? `${tunnelUrl}/mcp` : null,
      tunnelRunning,
      pairingActive: info.pairingActive === true,
    };
  }

  async function liveInfo(project) {
    const runtime = readRuntime(project.workspaceId);
    if (!runtime) return null;
    if (!isProcessAlive(runtime.pid)) return null;
    const info = await adminRequest(runtime, "GET", "/admin/info");
    if (info.workspaceId !== project.workspaceId) return null;
    return { runtime, info };
  }

  function commonStatus() {
    return {
      enabled: !disabled(),
      artifactReady: artifactReady(),
      cloudflaredAvailable: hasCommand("cloudflared"),
    };
  }

  async function status(projectId) {
    const common = commonStatus();
    if (!common.enabled) return { ok: true, ...common, state: "disabled", projectId: null };
    if (!common.artifactReady) return { ok: true, ...common, state: "prerequisites_missing", projectId: null };
    if (projectId === undefined || projectId === null || projectId === "") {
      return { ok: true, ...common, state: "ready", projectId: null };
    }
    const project = readProject(projectId);
    if (active && active.project.id !== project.id && isProcessAlive(active.child?.pid)) {
      return { ok: true, ...common, state: "busy", projectId: project.id, projectName: project.name };
    }
    if (active && active.project.id === project.id && isProcessAlive(active.child?.pid)) {
      try {
        const current = await liveInfo(project);
        if (current) return statusFromInfo(project, current.info, common);
      } catch {
        return { ok: true, ...common, projectId: project.id, projectName: project.name, state: "repair_needed" };
      }
    }
    const stale = readRuntime(project.workspaceId);
    if (stale && isProcessAlive(stale.pid)) {
      return { ok: true, ...common, projectId: project.id, projectName: project.name, state: "repair_needed" };
    }
    if (stale) clearRuntime(project.workspaceId);
    return { ok: true, ...common, projectId: project.id, projectName: project.name, state: "ready" };
  }

  async function stopChild(child) {
    const pid = child?.pid;
    if (!isProcessAlive(pid)) return;
    await stopProcessTreeGracefully({ pid, isAlive: isProcessAlive }).catch(() => undefined);
  }

  async function start(projectId) {
    if (disabled()) throw new ChatGptBridgeError("C2C_DISABLED", "ChatGPT integration is disabled", 409);
    if (!artifactReady()) throw new ChatGptBridgeError("PREREQUISITES_MISSING", "ChatGPT Bridge artifact is unavailable", 412);
    const project = readProject(projectId);
    if (active && isProcessAlive(active.child?.pid)) {
      if (active.project.id !== project.id) throw new ChatGptBridgeError("WORKSPACE_BUSY", "another workspace is active", 409);
      const current = await liveInfo(project);
      if (current) return statusFromInfo(project, current.info, commonStatus());
    }
    if (startInFlight) {
      if (startInFlight.projectId !== project.id) throw new ChatGptBridgeError("WORKSPACE_BUSY", "another workspace is starting", 409);
      return startInFlight.promise;
    }

    const stale = readRuntime(project.workspaceId);
    if (stale) {
      const owned = await liveInfo(project).catch(() => null);
      if (owned) await stopProcessTreeGracefully({ pid: owned.runtime.pid, isAlive: isProcessAlive }).catch(() => undefined);
      clearRuntime(project.workspaceId);
    }

    const child = spawnProcess(process.execPath, [artifactBin, "serve", "--workspace", project.root], {
      cwd: artifactRoot,
      env: { ...env },
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    active = { project, child };
    child.once("exit", () => {
      if (active?.child === child) active = null;
    });

    const promise = (async () => {
      const deadline = now() + STARTUP_TIMEOUT_MS;
      try {
        while (now() < deadline) {
          if (child.exitCode !== null) throw new ChatGptBridgeError("BRIDGE_START_FAILED", "Bridge failed to start", 502);
          const current = await liveInfo(project).catch(() => null);
          if (current && current.runtime.pid === child.pid) {
            active.runtime = current.runtime;
            active.info = current.info;
            log("ChatGPT Bridge started");
            return statusFromInfo(project, current.info, commonStatus());
          }
          await wait(STARTUP_POLL_MS);
        }
        throw new ChatGptBridgeError("BRIDGE_START_TIMEOUT", "Bridge did not become ready", 504);
      } catch (error) {
        await stopChild(child);
        clearRuntime(project.workspaceId);
        if (active?.child === child) active = null;
        if (error instanceof ChatGptBridgeError) throw error;
        throw new ChatGptBridgeError("BRIDGE_START_FAILED", "Bridge failed to start", 502);
      }
    })();
    startInFlight = { projectId: project.id, promise };
    try {
      return await promise;
    } finally {
      if (startInFlight?.promise === promise) startInFlight = null;
    }
  }

  async function setup(projectId) {
    if (disabled()) throw new ChatGptBridgeError("C2C_DISABLED", "ChatGPT integration is disabled", 409);
    if (!hasCommand("cloudflared")) {
      throw new ChatGptBridgeError("CLOUDFLARED_MISSING", "cloudflared is not installed", 412);
    }
    await start(projectId);
    const project = readProject(projectId);
    const current = await liveInfo(project);
    if (!current) throw new ChatGptBridgeError("BRIDGE_UNAVAILABLE", "Bridge is unavailable", 502);
    if (!current.info.publicUrl) await adminRequest(current.runtime, "POST", "/admin/tunnel/start", 90_000);
    const refreshed = await liveInfo(project);
    if (!refreshed) throw new ChatGptBridgeError("BRIDGE_UNAVAILABLE", "Bridge is unavailable", 502);
    return statusFromInfo(project, refreshed.info, commonStatus());
  }

  async function pair(projectId) {
    const project = readProject(projectId);
    if (!active || active.project.id !== project.id || !isProcessAlive(active.child?.pid)) await start(projectId);
    const current = await liveInfo(project);
    if (!current) throw new ChatGptBridgeError("BRIDGE_UNAVAILABLE", "Bridge is unavailable", 502);
    const connection = publicUrl(current.info.publicUrl);
    if (!connection) throw new ChatGptBridgeError("TUNNEL_REQUIRED", "secure connection is not ready", 412);
    const pairing = await adminRequest(current.runtime, "POST", "/admin/pairing");
    if (typeof pairing.code !== "string" || typeof pairing.expiresAt !== "number") {
      throw new ChatGptBridgeError("PAIRING_FAILED", "pairing is unavailable", 502);
    }
    return {
      ok: true,
      projectId: project.id,
      connectionUrl: `${connection}/mcp`,
      pairingCode: pairing.code,
      pairingExpiresAt: pairing.expiresAt,
    };
  }

  async function verify(projectId) {
    const project = readProject(projectId);
    const current = await liveInfo(project).catch(() => null);
    if (!current) return { ok: true, ...commonStatus(), projectId: project.id, projectName: project.name, state: "repair_needed" };
    return statusFromInfo(project, current.info, commonStatus());
  }

  async function stop(projectId) {
    const project = readProject(projectId);
    const owned = await liveInfo(project).catch(() => null);
    const child = active?.project.id === project.id ? active.child : null;
    if (owned) {
      await adminRequest(owned.runtime, "POST", "/admin/shutdown", 5_000).catch(() => undefined);
    }
    if (child) await stopChild(child);
    else if (owned) {
      await stopProcessTreeGracefully({ pid: owned.runtime.pid, isAlive: isProcessAlive }).catch(() => undefined);
    }
    clearRuntime(project.workspaceId);
    if (active?.project.id === project.id) active = null;
    return { ok: true, ...commonStatus(), projectId: project.id, projectName: project.name, state: "ready" };
  }

  async function disconnect(projectId, deleteState = false) {
    const project = readProject(projectId);
    const owned = await liveInfo(project).catch(() => null);
    if (owned) {
      await adminRequest(owned.runtime, "POST", "/admin/revoke-all", 5_000).catch(() => undefined);
      await adminRequest(owned.runtime, "POST", "/admin/tunnel/stop", 5_000).catch(() => undefined);
      await adminRequest(owned.runtime, "POST", "/admin/shutdown", 5_000).catch(() => undefined);
    }
    if (active?.project.id === project.id) await stopChild(active.child);
    else if (owned) {
      await stopProcessTreeGracefully({ pid: owned.runtime.pid, isAlive: isProcessAlive }).catch(() => undefined);
    }
    clearRuntime(project.workspaceId);
    if (active?.project.id === project.id) active = null;
    if (deleteState) {
      try {
        rmSync(join(c2cRoot, "auth", `${project.workspaceId}.json`), { force: true });
        rmSync(join(c2cRoot, "executions", `${project.workspaceId}.jsonl`), { force: true });
      } catch {
        // state deletion is best effort after revocation and shutdown
      }
    }
    return { ok: true, ...commonStatus(), projectId: project.id, projectName: project.name, state: "ready" };
  }

  async function setEnabled(enabled) {
    const nextEnabled = enabled === true;
    writeJsonAtomic(configFile, { version: 1, enabled: nextEnabled });
    if (!nextEnabled && active?.project?.id) await stop(active.project.id).catch(() => undefined);
    return { ok: true, enabled: nextEnabled && env.LEAFCODE_PI_C2C_DISABLED !== "1" };
  }

  async function shutdown() {
    if (active?.project?.id) await stop(active.project.id).catch(() => undefined);
  }

  return {
    artifactRoot,
    status,
    start,
    setup,
    pair,
    verify,
    stop,
    disconnect,
    setEnabled,
    shutdown,
  };
}
