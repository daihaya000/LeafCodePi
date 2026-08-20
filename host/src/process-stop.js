import { execSync as defaultExecSync } from "node:child_process";

function asPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function softKillTree(pid, deps = {}) {
  const id = asPid(pid);
  if (!id) return false;
  const run = deps.execSync ?? defaultExecSync;
  try {
    run(`taskkill /T /PID ${id}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hardKillTree(pid, deps = {}) {
  const id = asPid(pid);
  if (!id) return false;
  const run = deps.execSync ?? defaultExecSync;
  try {
    run(`taskkill /T /F /PID ${id}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
 * }} input
 */
export async function stopProcessTreeGracefully(input) {
  const pid = asPid(input.pid);
  if (!pid) return "gone";
  const softKill = input.softKill ?? softKillTree;
  const hardKill = input.hardKill ?? hardKillTree;
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
  return isAlive(pid) ? "hard" : "hard";
}
