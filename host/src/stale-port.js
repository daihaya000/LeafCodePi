import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEBUI_PORT, dataDir, readPort } from "./config.js";
import { pidAlive, readLock } from "./lock.js";
import { getListeningPids } from "./port-scanner.js";
import { stopProcessTreeGracefully } from "./process-stop.js";

const NEXT_PROCESS = /next-server|next[\\/]dist[\\/]bin[\\/]next|\bnext\s+(start|dev)\b/;

function defaultCommandLine(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    try {
      return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      return "";
    }
  }
}

function defaultEnvironment(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return [];
  }
}

/**
 * True only for a Next.js server the LeafCodePi host launched for this port.
 * Next renames its server process (`next-server (v15…)`), so the command line
 * alone cannot carry the port; the host-set LEAFCODE_PI_PORT environment does.
 */
export function isLeafCodeWebUi(port, { commandLine, environment }) {
  if (!NEXT_PROCESS.test(commandLine)) return false;
  if (environment.includes(`LEAFCODE_PI_PORT=${port}`)) return true;
  return new RegExp(`--port[ =]${port}(\\s|$)`).test(commandLine);
}

/**
 * Stop a WebUI left behind by a crashed host so the next start can bind the port.
 * A live host (host.lock) is never touched, and neither is any other program.
 * @returns {Promise<{ port: number, skipped?: string, stopped: number[], foreign: { pid: number, commandLine: string }[] }>}
 */
export async function reclaimStalePort(options = {}) {
  const env = options.env ?? process.env;
  const port = options.port ?? readPort(env.LEAFCODE_PI_PORT, DEFAULT_WEBUI_PORT);
  const result = { port, stopped: [], foreign: [] };
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ...result, skipped: "unsupported platform" };

  const lock = readLock(options.lockFile ?? join(dataDir(env), "host.lock"));
  const alive = options.pidAlive ?? pidAlive;
  if (lock && alive(lock.pid)) return { ...result, skipped: `host is running (PID ${lock.pid})` };

  const listing = options.getListeningPids ?? ((p) => getListeningPids(p));
  const commandLineOf = options.commandLine ?? defaultCommandLine;
  const environmentOf = options.environment ?? defaultEnvironment;
  const stop = options.stop ?? ((pid) => stopProcessTreeGracefully({ pid }));
  const wait = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const selfPid = options.selfPid ?? process.pid;

  const classify = (pid) => {
    const commandLine = commandLineOf(pid);
    return { pid, commandLine, owned: isLeafCodeWebUi(port, { commandLine, environment: environmentOf(pid) }) };
  };

  const holders = listing(port).filter((pid) => pid !== selfPid).map(classify);
  for (const holder of holders.filter((h) => h.owned)) {
    await stop(holder.pid);
    result.stopped.push(holder.pid);
  }

  // Give the kernel a moment to release the socket, then report what still holds it.
  for (let i = 0; i < (options.releaseTries ?? 10); i += 1) {
    if (listing(port).filter((pid) => pid !== selfPid).length === 0) break;
    await wait(options.releaseMs ?? 300);
  }
  result.foreign = listing(port)
    .filter((pid) => pid !== selfPid)
    .map(classify)
    .map(({ pid, commandLine }) => ({ pid, commandLine }));
  return result;
}
