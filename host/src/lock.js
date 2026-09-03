import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export function readLock(lockFile, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  if (!exists(lockFile)) return null;
  try {
    const raw = read(lockFile, "utf8").trim();
    if (raw.startsWith("{")) {
      const data = JSON.parse(raw);
      const pid = Number.parseInt(String(data.pid), 10);
      return Number.isFinite(pid) ? { pid } : null;
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? { pid } : null;
  } catch {
    return null;
  }
}

export function writeLock(lockFile, pid = process.pid, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  write(lockFile, `${JSON.stringify({ pid })}\n`, {
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
