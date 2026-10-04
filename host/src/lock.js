import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export function processStartKey(pid, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const read = deps.readFileSync ?? readFileSync;
  const spawn = deps.spawnSync ?? spawnSync;
  try {
    if (platform === "linux") {
      const stat = read(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const startTicks = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/)[19] : null;
      const bootId = read("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
    }
    if (platform === "win32") {
      const result = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000, windowsHide: true },
      );
      if (result.error || result.status !== 0) return null;
      const value = String(result.stdout ?? "").trim();
      return value ? `win:${value}` : null;
    }
    if (platform === "darwin") {
      const result = spawn("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000,
      });
      if (result.error || result.status !== 0) return null;
      const value = String(result.stdout ?? "").trim();
      return value ? `ps:${value}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function readLock(lockFile, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  if (!exists(lockFile)) return null;
  try {
    const raw = read(lockFile, "utf8").trim();
    if (raw.startsWith("{")) {
      const data = JSON.parse(raw);
      const pid = Number.parseInt(String(data.pid), 10);
      if (!Number.isFinite(pid)) return null;
      const processKey = typeof data.processKey === "string" ? data.processKey.trim() : "";
      return processKey ? { pid, processKey } : { pid };
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? { pid } : null;
  } catch {
    return null;
  }
}

/**
 * A lock file that parses as no owner is either a crashed leftover or a lock whose creator is
 * still between the exclusive create and the content write. Give a young file a short grace
 * period to finish before treating it as unreadable; an old one returns null immediately.
 * Returns the owner once it becomes readable, otherwise null.
 */
export function awaitLockOwner(lockFile, deps = {}) {
  const graceMs = deps.graceMs ?? 2_000;
  const pollMs = deps.pollMs ?? 50;
  const stat = deps.statSync ?? statSync;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  let ageMs;
  try { ageMs = now() - stat(lockFile).mtimeMs; } catch { return readLock(lockFile, deps); }
  const deadline = now() + Math.max(0, graceMs - Math.max(0, ageMs));
  for (;;) {
    const owner = readLock(lockFile, deps);
    if (owner || now() >= deadline) return owner;
    sleep(pollMs);
  }
}

export function writeLock(lockFile, pid = process.pid, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const processKey = typeof deps.processKey === "string" ? deps.processKey.trim() : "";
  const data = processKey ? { pid, processKey } : { pid };
  write(lockFile, `${JSON.stringify(data)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function removeLock(lockFile, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const unlink = deps.unlinkSync ?? unlinkSync;
  if (!exists(lockFile)) return;
  try {
    unlink(lockFile);
  } catch {
    /* ignore */
  }
}

export function pidAlive(pid, deps = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    // Only ESRCH means the process is gone. EPERM (and unknown errors) mean
    // the pid exists but we cannot signal it — treat as alive so we never
    // steal a live host's lock.
    if (code === "ESRCH") return false;
    return true;
  }
}

export function lockOwnerAlive(owner, deps = {}) {
  const alive = deps.pidAlive ?? pidAlive;
  if (!owner || !alive(owner.pid)) return false;
  if (typeof owner.processKey !== "string" || !owner.processKey) return true;
  try {
    const currentKey = deps.getProcessKey?.(owner.pid);
    // Missing process metadata is inconclusive; never steal a possibly live lock.
    return !currentKey || currentKey === owner.processKey;
  } catch {
    return true;
  }
}
