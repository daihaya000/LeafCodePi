/**
 * llama-server process lifecycle service.
 *
 * The server is a tray-independent resident: it must survive LeafCode's own
 * process ending (normal quit or force-kill). Windows launches a temporary bat
 * outside LeafCode.exe's Kill-On-Job-Close job via WMI. Linux/macOS spawn the
 * configured llama-server binary directly in a detached process group.
 *
 * status/start/stop are deliberately asynchronous at the process boundary:
 * start() launches the server and returns immediately; status() does the live
 * /health probe and port check on demand. The BFF polls status() from the UI.
 */

import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, posix, sep } from 'path';

/**
 * Optional overrides for the start config. All map to the bat's env vars.
 * @typedef {Object} LlamaServerStartConfig
 * @property {string} [effort] REASONING_EFFORT default (low|medium|xhigh).
 * @property {number} [contextLength] CONTEXT_LENGTH (-c).
 * @property {number} [parallel] PARALLEL (-np).
 * @property {string} [llamaServerBin] LLAMA_SERVER_BIN (llama-server.exe path).
 * @property {string} [modelDir] MODEL_DIR (GGUF model root).
 * @property {string} [modelFile] MODEL_FILE (model path relative to MODEL_DIR).
 * @property {'127.0.0.1' | '0.0.0.0'} [llamaServerHost] LLAMA_SERVER_HOST
 *   (bind address; 0.0.0.0 opens the server to LAN/Tailscale clients).
 * @property {string} [specType] SPEC_TYPE (--spec-type; "" = off). Only
 *   "draft-mtp" today, and only for GGUFs bundling MTP tensors.
 * @property {string} [cacheTypeK] CT_K (--cache-type-k; "" = f16 default).
 * @property {string} [cacheTypeV] CT_V (--cache-type-v; "" = f16 default).
 */

/**
 * On Windows the bat interpolates these env vars into a quoted command line
 * under `setlocal enabledelayedexpansion`, so a value carrying `"`, `%`, `!`,
 * `&`, `|`, `<`, `>` or `^` would break out of the quoting and run commands.
 * The BFF rejects them too; this is the check at the spawn point itself.
 */
const WINDOWS_UNSAFE_PATH_CHARS = /["%!&|<>^*?\u0000-\u001f]/;
const POSIX_UNSAFE_PATH_CHARS = /[\u0000-\u001f]/;

/** @param {unknown} value @param {string} platform */
function isUnsafePathValue(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 400) return true;
  const unsafe = platform === 'win32' ? WINDOWS_UNSAFE_PATH_CHARS : POSIX_UNSAFE_PATH_CHARS;
  return unsafe.test(value);
}

/** @param {unknown} value @param {string} platform */
function isSafeModelFile(value, platform = process.platform) {
  if (isUnsafePathValue(value, platform)) return false;
  if (value === '') return true;
  if (!String(value).toLowerCase().endsWith('.gguf')) return false;
  const normalized = String(value).replaceAll('\\', '/');
  const absolute = platform === 'win32' ? isAbsolute(normalized) : posix.isAbsolute(normalized);
  return !absolute && !normalized.split('/').includes('..');
}

/**
 * @typedef {Object} LlamaServerStatus
 * @property {boolean} running /health is ok OR a live PID owns the port.
 * @property {number | null} pid the tracked owned PID (may already be dead).
 * @property {number[]} listeningPids PIDs listening on the port right now.
 * @property {string | null} health raw /health status, or null on failure.
 * @property {number} port configured llama-server port.
 */

/**
 * @param {{
 *   batPath?: string,
 *   port: number,
 *   platform?: string,
 *   defaultBin?: string,
 *   defaultModelDir?: string,
 *   trayEnabled?: boolean,
 *   getListeningPids?: (port: number) => number[],
 *   getPortListenerStatus?: (port: number) => { available: boolean, listening: boolean, pids: number[] },
 *   getProcessStartTime?: (pid: number) => string | null,
 *   ownershipFile?: string | null,
 *   fetch?: typeof fetch,
 *   spawn?: typeof spawn,
 *   spawnSync?: typeof spawnSync,
 *   writeFile?: (path: string, data: string) => void,
 *   tmpDir?: () => string,
 *   trayScript?: string | null,
 *   isProcessAlive?: (pid: number) => boolean,
 *   isOwnedProcess?: (pid: number, marker: string | null) => boolean,
 *   isLlamaServerProcess?: (pid: number, marker: string | null) => boolean,
 *   stopProcessTreeGracefully?: (input: { pid: number, softKill?: (pid: number) => boolean, hardKill?: (pid: number) => boolean, isAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, softWaitMs?: number, pollMs?: number }) => Promise<'soft' | 'hard' | 'gone'>,
 * }} deps
 */
export function createLlamaServerService(deps) {
  const platform = deps.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const batPath = deps.batPath;
  const port = deps.port;
  const defaultBin = deps.defaultBin ?? (
    isWindows
      ? null
      : process.env.LEAFCODE_PI_LLAMA_SERVER_BIN?.trim() || process.env.LLAMA_SERVER_BIN?.trim() || 'llama-server'
  );
  const defaultModelDir = deps.defaultModelDir ?? (
    isWindows
      ? null
      : process.env.LEAFCODE_PI_LLAMA_MODEL_DIR?.trim() || join(homedir(), 'models', 'llm')
  );
  const pathJoin = isWindows ? join : posix.join;
  const pathSeparator = isWindows ? sep : posix.sep;
  const trayEnabled = deps.trayEnabled ?? isWindows;
  const getListeningPids = deps.getListeningPids ?? (() => []);
  const getPortListenerStatus = deps.getPortListenerStatus ?? ((targetPort) => {
    const pids = getListeningPids(targetPort);
    return { available: true, listening: pids.length > 0, pids };
  });
  const getProcessStartTime = deps.getProcessStartTime ?? (() => null);
  const ownershipFile = deps.ownershipFile ?? null;
  const doFetch = deps.fetch ?? fetch;
  const writeFile = deps.writeFile ?? writeFileSync;
  const getTmpDir = deps.tmpDir ?? tmpdir;
  const spawnFn = deps.spawn ?? spawn;
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  const trayScript = deps.trayScript ?? null;
  const isProcessAlive =
    deps.isProcessAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const stopTree = deps.stopProcessTreeGracefully ?? null;
  function serverMarker(config) {
    return config.llamaServerBin?.trim() || (isWindows ? 'llama-server.exe' : defaultBin);
  }
  const isOwnedProcess = deps.isOwnedProcess ?? (() => true);
  const isLlamaServerProcess = deps.isLlamaServerProcess ?? (() => false);
  /** @type {number | null} */
  let ownedPid = null;
  /** @type {number | null} */
  let trayPid = null;
  /** @type {string | null} */
  let ownedCommandMarker = null;
  /** @type {string | null} */
  let trayCommandMarker = null;
  /** @type {string | null} */
  let serverCommandMarker = null;
  /** @type {string | null} */
  let ownedStartTime = null;
  /** @type {string | null} */
  let trayStartTime = null;
  let ownershipRestored = false;
  const serverListenerPids = new Set();
  const serverListenerStartTimes = new Map();

  function parsePid(value) {
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }

  function parseStartTime(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
  }

  function currentStartTime(pid) {
    if (!parsePid(pid)) return null;
    try {
      return parseStartTime(getProcessStartTime(pid));
    } catch {
      return null;
    }
  }

  function resetTracking(removeFile = false) {
    ownedPid = null;
    trayPid = null;
    ownedCommandMarker = null;
    trayCommandMarker = null;
    serverCommandMarker = null;
    ownedStartTime = null;
    trayStartTime = null;
    ownershipRestored = false;
    serverListenerPids.clear();
    serverListenerStartTimes.clear();
    if (removeFile && ownershipFile) {
      try {
        rmSync(ownershipFile, { force: true });
      } catch {
        /* stale ownership is best effort */
      }
    }
  }

  function loadOwnership() {
    if (!ownershipFile) return;
    try {
      const value = JSON.parse(readFileSync(ownershipFile, 'utf8'));
      const pid = parsePid(value?.pid);
      const commandMarker = typeof value?.commandMarker === 'string' ? value.commandMarker : null;
      const marker = typeof value?.serverCommandMarker === 'string' ? value.serverCommandMarker : null;
      const startTime = parseStartTime(value?.pidStartTime);
      if (!pid || !commandMarker || !marker || value?.port !== port || !startTime) return;
      ownedPid = pid;
      ownedCommandMarker = commandMarker;
      serverCommandMarker = marker;
      ownedStartTime = startTime;
      const nextTrayPid = parsePid(value?.trayPid);
      const nextTrayMarker = typeof value?.trayCommandMarker === 'string'
        ? value.trayCommandMarker
        : null;
      const nextTrayStart = parseStartTime(value?.trayStartTime);
      if (nextTrayPid && nextTrayMarker && nextTrayStart) {
        trayPid = nextTrayPid;
        trayCommandMarker = nextTrayMarker;
        trayStartTime = nextTrayStart;
      }
      if (Array.isArray(value?.listeners)) {
        for (const listener of value.listeners) {
          const listenerPid = parsePid(listener?.pid);
          if (!listenerPid) continue;
          serverListenerPids.add(listenerPid);
          const listenerStart = parseStartTime(listener?.startTime);
          if (listenerStart) serverListenerStartTimes.set(listenerPid, listenerStart);
        }
      }
      ownershipRestored = true;
    } catch {
      /* missing or malformed ownership is not trusted */
    }
  }

  function saveOwnership() {
    if (
      !ownershipFile ||
      !ownedPid ||
      !ownedCommandMarker ||
      !serverCommandMarker ||
      !ownedStartTime
    ) return;
    try {
      mkdirSync(dirname(ownershipFile), { recursive: true, mode: 0o700 });
      writeFileSync(
        ownershipFile,
        `${JSON.stringify({
          version: 1,
          port,
          pid: ownedPid,
          commandMarker: ownedCommandMarker,
          serverCommandMarker,
          pidStartTime: ownedStartTime,
          ...(trayPid && trayCommandMarker && trayStartTime
            ? { trayPid, trayCommandMarker, trayStartTime }
            : {}),
          listeners: [...serverListenerPids].map((pid) => ({
            pid,
            ...(serverListenerStartTimes.get(pid)
              ? { startTime: serverListenerStartTimes.get(pid) }
              : {}),
          })),
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      if (!isWindows) {
        chmodSync(dirname(ownershipFile), 0o700);
        chmodSync(ownershipFile, 0o600);
      }
    } catch {
      /* ownership persistence is best effort; runtime checks still apply */
    }
  }

  function processMatches(pid, marker, startTime, requireStartTime = false) {
    if (!parsePid(pid) || !marker || !isProcessAlive(pid)) return false;
    if (!isOwnedProcess(pid, marker)) return false;
    if (!startTime) return !requireStartTime;
    const current = currentStartTime(pid);
    if (!current) return !requireStartTime;
    return current === startTime;
  }

  function rememberServerListeners(listeningPids = getListeningPids(port)) {
    if (!serverCommandMarker) return;
    const currentPids = new Set(listeningPids.map(parsePid).filter((pid) => pid !== null));
    for (const pid of [...serverListenerPids]) {
      const expectedStart = ownershipRestored && pid === ownedPid
        ? ownedStartTime
        : serverListenerStartTimes.get(pid);
      if (
        !currentPids.has(pid) ||
        (ownershipRestored && pid === ownedPid && !expectedStart) ||
        (expectedStart && currentStartTime(pid) !== expectedStart) ||
        !isLlamaServerProcess(pid, serverCommandMarker)
      ) {
        serverListenerPids.delete(pid);
        serverListenerStartTimes.delete(pid);
      }
    }
    for (const pid of currentPids) {
      const expectedStart = ownershipRestored && pid === ownedPid
        ? ownedStartTime
        : serverListenerStartTimes.get(pid);
      if (
        (ownershipRestored && pid === ownedPid && !expectedStart) ||
        (expectedStart && currentStartTime(pid) !== expectedStart) ||
        !isLlamaServerProcess(pid, serverCommandMarker)
      ) continue;
      serverListenerPids.add(pid);
      const startTime = currentStartTime(pid);
      if (startTime) serverListenerStartTimes.set(pid, startTime);
    }
  }

  loadOwnership();

  function portStatus() {
    try {
      const value = getPortListenerStatus(port);
      if (!value || value.available !== true || !Array.isArray(value.pids)) {
        return { available: false, listening: false, pids: [] };
      }
      return {
        available: true,
        listening: value.listening === true,
        pids: value.pids.map(parsePid).filter((pid) => pid !== null),
      };
    } catch {
      return { available: false, listening: false, pids: [] };
    }
  }

  async function fetchHealth() {
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      if (body && typeof body === 'object' && body.status === 'ok') return 'ok';
      return null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<LlamaServerStatus>} */
  async function status() {
    const listeners = portStatus();
    const listeningPids = listeners.pids;
    rememberServerListeners(listeningPids);
    const ownedAlive = processMatches(
      ownedPid,
      ownedCommandMarker,
      ownedStartTime,
      ownershipRestored,
    );
    const verifiedListener = serverListenerPids.size > 0;
    const health = await fetchHealth();
    // A listener counts only after its command line matches the recorded
    // llama-server marker. Unknown listeners never become owned by adoption.
    const running = health === 'ok' || ownedAlive || verifiedListener;
    saveOwnership();
    return {
      running,
      pid: ownedPid,
      port,
      listeningPids,
      health,
    };
  }

  /**
   * Build a temporary UTF-8 (no BOM) launcher bat that inlines the config as
   * `set` lines, then `call`s the real llama-server-load.bat. WMI launch does
   * not inherit the caller's environment, so the config must live in the bat.
   * CRLF + `chcp 65001` keep non-ASCII path values intact (cmd parses a
   * UTF-8-no-BOM bat correctly only under cp65001).
   * @param {LlamaServerStartConfig} config
   * @returns {{ path: string, cmdLine: string }}
   */
  function buildLauncher(config) {
    const name = `llama-launch-${randomBytes(6).toString('hex')}.bat`;
    const path = join(getTmpDir(), name);
    const lines = ['@echo off', 'chcp 65001 >nul', 'setlocal EnableDelayedExpansion'];
    lines.push(`set "SERVER_PORT=${port}"`);
    if (config.effort !== undefined) {
      lines.push(`set "REASONING_EFFORT=${config.effort}"`);
      if (config.effort === '') lines.push('set "LEAFCODE_PI_EMPTY_EFFORT=1"');
    }
    if (config.contextLength)
      lines.push(`set "CONTEXT_LENGTH=${String(config.contextLength)}"`);
    if (config.parallel) lines.push(`set "PARALLEL=${String(config.parallel)}"`);
    if (config.llamaServerBin) lines.push(`set "LLAMA_SERVER_BIN=${config.llamaServerBin}"`);
    if (config.modelDir) lines.push(`set "MODEL_DIR=${config.modelDir}"`);
    if (config.modelFile) lines.push(`set "MODEL_FILE=${config.modelFile}"`);
    if (config.llamaServerHost)
      lines.push(`set "LLAMA_SERVER_HOST=${config.llamaServerHost}"`);
    if (config.specType) lines.push(`set "SPEC_TYPE=${config.specType}"`);
    if (config.cacheTypeK) lines.push(`set "CT_K=${config.cacheTypeK}"`);
    if (config.cacheTypeV) lines.push(`set "CT_V=${config.cacheTypeV}"`);
    // The real bat blocks until the model is loaded, so the self-delete line
    // below only runs after it exits. The launcher removes itself so a temp
    // file is not left behind, and there is no window where the WMI-spawned
    // cmd has not yet read the file while we delete it.
    lines.push(`call "${batPath}"`, 'endlocal', 'del "%~f0" >nul 2>&1');
    writeFile(path, `${lines.join('\r\n')}\r\n`);
    return path;
  }

  /**
   * Launch the bat outside the host's Kill-On-Job-Close job so llama-server
   * survives LeafCode quitting. WMI (Win32_Process.Create) spawns the process
   * in a fresh job, detached from ours. Falls back to a normal spawn (still
   * inside the job) if WMI is unavailable, so the server still works even when
   * it cannot be made fully independent.
   * @param {string} launcherPath absolute path to the temporary launcher bat.
   * @returns {number | null} PID of the WMI-spawned launcher, or null.
   */
  function launchViaWmi(launcherPath) {
    // The launcher cmdline holds double quotes (bat path), which would need
    // escaping through a `-Command` string. Pass the whole script as an
    // -EncodedCommand (base64 UTF-16LE) so no quoting is interpreted.
    const quoted = launcherPath.replace(/'/g, "''");
    const ps =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = 'cmd.exe /c call "${quoted}"' }; ` +
      `if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const out = spawnSyncFn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
      const pid = Number(String(out.stdout ?? '').trim());
      if (out.status !== 0 || !Number.isInteger(pid) || pid <= 1) return null;
      return pid;
    } catch {
      return null;
    }
  }

  /**
   * Launch a standalone Node script (the llama-server tray) via WMI, outside
   * the host's Kill-On-Job-Close job, so it survives LeafCode quitting. WMI
   * does not inherit the caller's environment, so pass the node executable
   * path and the script path explicitly in the CommandLine.
   * @param {string} scriptPath absolute path to the .mjs entry.
   * @param {...string} args arguments passed to the script.
   * @returns {number | null} PID of the WMI-spawned node, or null on failure.
   */
  function launchNodeViaWmi(scriptPath, ...args) {
    const nodeExe = process.execPath;
    const quotedScript = scriptPath.replace(/'/g, "''");
    const quotedExe = nodeExe.replace(/'/g, "''");
    const commandArgs = args
      .map((arg) => `"${String(arg).replace(/'/g, "''")}"`)
      .join(' ');
    const ps =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = '"${quotedExe}" "${quotedScript}" ${commandArgs}' }; ` +
      `if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const out = spawnSyncFn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
      const pid = Number(String(out.stdout ?? '').trim());
      if (out.status !== 0 || !Number.isInteger(pid) || pid <= 1) return null;
      return pid;
    } catch {
      return null;
    }
  }

  /** Build a direct POSIX launch; unlike the Windows bat this needs no shell. */
  function buildPosixLaunch(config) {
    const binary = config.llamaServerBin?.trim() || defaultBin;
    if (!binary) throw new Error('llama-server binary is not configured');
    const modelDir = config.modelDir?.trim() || defaultModelDir;
    if (!modelDir) throw new Error('llama-server model directory is not configured');
    const args = [
      '--host', config.llamaServerHost || '127.0.0.1',
      '--port', String(port),
      '-c', String(config.contextLength || 32768),
      '-np', String(config.parallel || 1),
      '-ngl', '999',
      '-fa', 'on',
      '--temp', '0.6',
      '--top-p', '0.95',
      '--top-k', '20',
      '--jinja',
    ];
    if (config.cacheTypeK) args.push('--cache-type-k', config.cacheTypeK);
    if (config.cacheTypeV) args.push('--cache-type-v', config.cacheTypeV);
    if (config.specType) args.push('--spec-type', config.specType);
    if (config.effort) {
      args.push('--chat-template-kwargs', JSON.stringify({ reasoning_effort: config.effort }));
    }
    if (config.modelFile) {
      const modelFile = String(config.modelFile).replaceAll('\\', pathSeparator);
      const modelPath = pathJoin(modelDir, modelFile);
      const alias = modelFile.split(pathSeparator).pop()?.replace(/\.gguf$/i, '') || 'model';
      args.push('-m', modelPath, '--alias', alias);
    } else {
      args.push('--models-dir', modelDir);
    }
    return { binary, args };
  }

  function launchDetached(command, args, options = {}) {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...options,
    });
    const pid = parsePid(child.pid);
    if (typeof child.once === 'function') {
      const clearOwnedPid = () => {
        if (ownedPid === pid) {
          ownedPid = null;
          ownedCommandMarker = null;
        }
        if (trayPid === pid) {
          trayPid = null;
          trayCommandMarker = null;
        }
      };
      child.once('error', clearOwnedPid);
      child.once('close', clearOwnedPid);
    }
    const ready = typeof child.on === 'function'
      ? new Promise((resolve, reject) => {
          child.once('spawn', () => resolve(pid));
          child.once('error', reject);
        })
      : Promise.resolve(pid);
    child.unref?.();
    return { pid, ready };
  }

  /**
   * Start the server as a resident outside the host's Kill On Job Close.
   * @param {LlamaServerStartConfig} [config]
   * @returns {Promise<{ ok: boolean, pid: number | null, trayPid?: number | null, error?: string }>}
   */
  async function start(config = {}) {
    // Reject a double-start: if we already own a live PID or /health responds
    // ok, the server is already running. A port listener alone is NOT enough —
    // another process (e.g. Caddy) may occupy the port.
    const ownedAlive = processMatches(
      ownedPid,
      ownedCommandMarker,
      ownedStartTime,
      ownershipRestored,
    );
    if (ownedAlive) {
      return { ok: false, pid: ownedPid, error: 'llama-server is already running' };
    }
    if ((await fetchHealth()) === 'ok') {
      saveOwnership();
      return { ok: false, pid: ownedPid, error: 'llama-server is already running' };
    }
    const existingListeners = portStatus();
    if (!existingListeners.available) {
      return { ok: false, pid: null, error: 'llama-server port status is unavailable' };
    }
    if (existingListeners.listening) {
      return { ok: false, pid: null, error: 'llama-server port is already in use' };
    }
    for (const key of ['llamaServerBin', 'modelDir']) {
      if (config[key] !== undefined && isUnsafePathValue(config[key], platform)) {
        return { ok: false, pid: null, error: `unsafe llama-server path value: ${key}` };
      }
    }
    if (config.modelFile !== undefined && !isSafeModelFile(config.modelFile, platform)) {
      return { ok: false, pid: null, error: 'unsafe llama-server path value: modelFile' };
    }

    try {
      resetTracking(true);
      if (!isWindows) {
        const launch = buildPosixLaunch(config);
        serverCommandMarker = serverMarker(config);
        ownedCommandMarker = launch.binary;
        const started = launchDetached(launch.binary, launch.args);
        ownedPid = started.pid;
        if (!ownedPid) throw new Error('llama-server did not return a process id');
        await started.ready;
        ownedStartTime = currentStartTime(ownedPid);
        if (trayEnabled && trayScript) {
          trayCommandMarker = trayScript;
          const tray = launchDetached(process.execPath, [
            trayScript,
            String(port),
            serverCommandMarker,
            String(ownedPid),
            ownedStartTime ?? '',
          ]);
          trayPid = tray.pid;
          try {
            await tray.ready;
            trayStartTime = currentStartTime(trayPid);
          } catch {
            trayPid = null;
            trayCommandMarker = null;
          }
        } else {
          trayPid = null;
        }
        rememberServerListeners();
        saveOwnership();
        return { ok: true, pid: ownedPid, trayPid };
      }

      const launcherPath = buildLauncher(config);
      serverCommandMarker = serverMarker(config);
      ownedCommandMarker = launcherPath;
      const wmiPid = launchViaWmi(launcherPath);
      if (wmiPid !== null) {
        ownedPid = wmiPid;
      } else {
        // Fallback: spawn inside the current tree (still works, just not
        // independent of the host). The bat's own `start` keeps llama-server.exe
        // alive past the bat, but the host's Kill Job still reaches it.
        const started = launchDetached('cmd.exe', ['/c', launcherPath], {
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        ownedPid = started.pid;
        if (!ownedPid) throw new Error('llama-server launcher did not return a process id');
        await started.ready;
      }
      ownedStartTime = currentStartTime(ownedPid);
      // Launch the standalone llama-server tray (a separate resident process)
      // alongside the server, also outside the host's Kill Job. Best-effort: a
      // failure here must not fail the server start.
      if (trayEnabled && trayScript) {
        trayCommandMarker = trayScript;
        trayPid = launchNodeViaWmi(
          trayScript,
          String(port),
          serverCommandMarker,
          String(ownedPid),
          ownedStartTime ?? '',
        );
        trayStartTime = currentStartTime(trayPid);
      } else {
        trayPid = null;
      }
      rememberServerListeners();
      saveOwnership();
      return { ok: true, pid: ownedPid, trayPid };
    } catch (err) {
      resetTracking(true);
      return {
        ok: false,
        pid: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop the server and its standalone tray. The bat uses `start`, so
   * llama-server.exe is reparented once the bat exits and is NOT in the
   * launcher tree — kill the owned launcher (covers the bat's own children)
   * plus listeners verified as this server. The tray is killed by its PID.
   * @returns {Promise<{ ok: boolean, killed: number[] }>}
   */
  async function stop() {
    const listeners = portStatus();
    const listeningPids = listeners.pids;
    rememberServerListeners(listeningPids);
    const pidSet = new Set();
    if (processMatches(ownedPid, ownedCommandMarker, ownedStartTime, ownershipRestored)) {
      pidSet.add(ownedPid);
    }
    if (processMatches(trayPid, trayCommandMarker, trayStartTime, ownershipRestored)) {
      pidSet.add(trayPid);
    }
    for (const pid of listeningPids) {
      const n = parsePid(pid);
      const expectedStart = n
        ? ownershipRestored && n === ownedPid
          ? ownedStartTime
          : serverListenerStartTimes.get(n)
        : null;
      const startMatches = Boolean(expectedStart) && currentStartTime(n) === expectedStart;
      const identityMatches = ownershipRestored && n === ownedPid
        ? processMatches(n, ownedCommandMarker, ownedStartTime, true)
        : true;
      if (
        n &&
        serverListenerPids.has(n) &&
        isLlamaServerProcess(n, serverCommandMarker) &&
        (expectedStart ? startMatches : !ownershipRestored) &&
        identityMatches
      ) {
        pidSet.add(n);
      }
    }
    const killed = [];
    for (const pid of pidSet) {
      if (stopTree) {
        await stopTree({ pid, platform });
      }
      killed.push(pid);
    }
    resetTracking(true);
    return { ok: true, killed };
  }

  return { status, start, stop };
}
