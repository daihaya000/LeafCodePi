import { execSync as defaultExecSync } from "node:child_process";

function asPid(pid) {
  const n = Number(pid);
  // On POSIX kill(-1, signal) broadcasts to every process the caller may signal.
  if (!Number.isInteger(n) || n <= 1) return null;
  return n;
}

function signalProcessTree(pid, signal, deps) {
  const id = asPid(pid);
  if (!id) return false;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const run = deps.execSync ?? defaultExecSync;
    try {
      run(`taskkill /T${signal === "SIGKILL" ? " /F" : ""} /PID ${id}`, {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  const kill = deps.kill ?? process.kill.bind(process);
  try {
    // Linux/macOS children are launched detached, making the child PID the
    // process-group ID. Fall back to the process itself for external PIDs.
    kill(-id, signal);
    return true;
  } catch {
    try {
      kill(id, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function softKillTree(pid, deps = {}) {
  return signalProcessTree(pid, "SIGTERM", deps);
}

export function hardKillTree(pid, deps = {}) {
  return signalProcessTree(pid, "SIGKILL", deps);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Soft kill, wait, then hard kill if still alive.
 * @param {{
 *   pid: number,
 *   softKill?: (pid: number) => boolean,
 *   hardKill?: (pid: number) => boolean,
 *   isAlive?: (pid: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 *   softWaitMs?: number,
 *   pollMs?: number,
 *   platform?: string,
 *   kill?: (pid: number, signal: string) => void,
 * }} input
 */
export async function stopProcessTreeGracefully(input) {
  const pid = asPid(input.pid);
  if (!pid) return "gone";
  const softKill = input.softKill ?? ((id) => softKillTree(id, { platform: input.platform, kill: input.kill }));
  const hardKill = input.hardKill ?? ((id) => hardKillTree(id, { platform: input.platform, kill: input.kill }));
  const isAlive =
    input.isAlive ??
    ((id) => {
      try {
        process.kill(id, 0);
        return true;
      } catch {
        return false;
      }
    });
  const wait = input.sleep ?? sleep;
  const softWaitMs = input.softWaitMs ?? 2500;
  const pollMs = input.pollMs ?? 200;

  if (!isAlive(pid)) return "gone";
  softKill(pid);
  const softDeadline = Date.now() + softWaitMs;
  while (Date.now() < softDeadline) {
    if (!isAlive(pid)) return "soft";
    await wait(pollMs);
  }
  if (!isAlive(pid)) return "soft";
  hardKill(pid);
  await wait(pollMs);
  return isAlive(pid) ? "alive" : "hard";
}
