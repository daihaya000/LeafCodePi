/**
 * llama-server process lifecycle service.
 *
 * The server is a tray-independent resident: it must survive LeafCode's own
 * process ending (normal quit or force-kill). LeafCode.exe wraps the whole
 * tree in a Kill-On-Job-Close job, so a plain child spawn dies with the host.
 * To escape that job this service launches scripts/llama-server-load.bat via
 * WMI (Win32_Process.Create), which spawns the process outside any job the
 * host belongs to. The bat uses `start` for llama-server.exe itself, so it is
 * already independent once launched; WMI just moves the whole batch out of the
 * host's job. Config values are inlined into a temporary UTF-8 launcher bat
 * (WMI does not inherit the caller's environment variables), which then `call`s
 * the real llama-server-load.bat.
 *
 * status/start/stop are deliberately synchronous: start() launches via WMI and
 * returns immediately (the bat polls /health); status() does the live /health
 * probe and port check on demand. The BFF polls status() from the UI.
 */

import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
 * The bat interpolates these env vars into a quoted command line under
 * `setlocal enabledelayedexpansion`, so a value carrying `"`, `%`, `!`, `&`,
 * `|`, `<`, `>` or `^` would break out of the quoting and run commands. The BFF
 * rejects them too (web/src/lib/llama-server-settings.ts); this is the check at
 * the spawn point itself, which no caller can bypass.
 */
const UNSAFE_PATH_CHARS = /["%!&|<>^*?\u0000-\u001f]/;

/** @param {unknown} value */
function isUnsafePathValue(value) {
  return typeof value !== 'string' || value.length > 400 || UNSAFE_PATH_CHARS.test(value);
}

/**
 * @typedef {Object} LlamaServerStatus
 * @property {boolean} running /health is ok OR a live PID owns the port.
 * @property {number | null} pid the tracked owned PID (may already be dead).
 * @property {number[]} listeningPids PIDs listening on the port right now.
 * @property {string | null} health raw /health status, or null on failure.
 */

/**
 * @param {{
 *   batPath: string,
 *   port: number,
 *   getListeningPids?: (port: number) => number[],
 *   fetch?: typeof fetch,
 *   spawn?: typeof spawn,
 *   spawnSync?: typeof spawnSync,
 *   writeFile?: (path: string, data: string) => void,
 *   tmpDir?: () => string,
 *   trayScript?: string | null,
 *   isProcessAlive?: (pid: number) => boolean,
 *   stopProcessTreeGracefully?: (input: { pid: number, softKill?: (pid: number) => boolean, hardKill?: (pid: number) => boolean, isAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, softWaitMs?: number, pollMs?: number }) => Promise<'soft' | 'hard' | 'gone'>,
 * }} deps
 */
export function createLlamaServerService(deps) {
  const batPath = deps.batPath;
  const port = deps.port;
  const getListeningPids = deps.getListeningPids ?? (() => []);
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

  /** @type {number | null} */
  let ownedPid = null;
  /** @type {number | null} */
  let trayPid = null;

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
    const listeningPids = getListeningPids(port);
    const ownedAlive = ownedPid !== null && isProcessAlive(ownedPid);
    const health = await fetchHealth();
    // running = /health ok, or the launcher is still alive (bat just spawned,
    // /health not ready yet). A port listener alone is NOT enough — another
    // process (e.g. Caddy) may occupy the port.
    const running = health === 'ok' || ownedAlive;
    return {
      running,
      pid: ownedPid,
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
    if (config.effort) lines.push(`set "REASONING_EFFORT=${config.effort}"`);
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
      if (out.status !== 0 || !Number.isInteger(pid) || pid <= 0) return null;
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
   * @param {string} arg single string argument (the port).
   * @returns {number | null} PID of the WMI-spawned node, or null on failure.
   */
  function launchNodeViaWmi(scriptPath, arg) {
    const nodeExe = process.execPath;
    const quotedScript = scriptPath.replace(/'/g, "''");
    const quotedExe = nodeExe.replace(/'/g, "''");
    const ps =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = '"${quotedExe}" "${quotedScript}" "${arg}"' }; ` +
      `if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const out = spawnSyncFn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
      const pid = Number(String(out.stdout ?? '').trim());
      if (out.status !== 0 || !Number.isInteger(pid) || pid <= 0) return null;
      return pid;
    } catch {
      return null;
    }
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
    const ownedAlive = ownedPid !== null && isProcessAlive(ownedPid);
    if (ownedAlive) {
      return { ok: false, pid: ownedPid, error: 'llama-server is already running' };
    }
    if ((await fetchHealth()) === 'ok') {
      return { ok: false, pid: ownedPid, error: 'llama-server is already running' };
    }
    for (const key of ['llamaServerBin', 'modelDir', 'modelFile']) {
      if (config[key] !== undefined && isUnsafePathValue(config[key])) {
        return { ok: false, pid: null, error: `unsafe llama-server path value: ${key}` };
      }
    }
  const launcherPath = buildLauncher(config);
  try {
    const wmiPid = launchViaWmi(launcherPath);
    if (wmiPid !== null) {
      ownedPid = wmiPid;
    } else {
      // Fallback: spawn inside the current tree (still works, just not
      // independent of the host). The bat's own `start` keeps llama-server.exe
      // alive past the bat, but the host's Kill Job still reaches it.
      const child = spawnFn('cmd.exe', ['/c', launcherPath], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      ownedPid = child.pid ?? null;
    }
    // Launch the standalone llama-server tray (a separate resident process)
    // alongside the server, also outside the host's Kill Job. Best-effort: a
    // failure here must not fail the server start.
    if (trayScript) {
      trayPid = launchNodeViaWmi(trayScript, String(port));
    }
    return { ok: true, pid: ownedPid, trayPid };
  } catch (err) {
    trayPid = null;
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
   * plus every live listener on the port. The tray is killed by its PID.
   * @returns {Promise<{ ok: boolean, killed: number[] }>}
   */
  async function stop() {
    const listeningPids = getListeningPids(port);
    const ownedAlive = ownedPid !== null && isProcessAlive(ownedPid);
    const trayAlive = trayPid !== null && isProcessAlive(trayPid);
    const pidSet = new Set();
    if (ownedAlive) pidSet.add(ownedPid);
    if (trayAlive) pidSet.add(trayPid);
    for (const pid of listeningPids) {
      const n = Number(pid);
      if (Number.isFinite(n) && n > 0) pidSet.add(n);
    }
    const killed = [];
    for (const pid of pidSet) {
      if (stopTree) {
        await stopTree({ pid });
      }
      killed.push(pid);
    }
    ownedPid = null;
    trayPid = null;
    return { ok: true, killed };
  }

  return { status, start, stop };
}
