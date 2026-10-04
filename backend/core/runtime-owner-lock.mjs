import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryLock } from "./directory-lock.mjs";

const INITIAL_OWNER_GRACE_MS = 2_000;

/** Stable identity that distinguishes a reused PID from the process that wrote the lock. */
export function processStartKey(pid, { platform = process.platform } = {}) {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const startTicks = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/)[19] : undefined;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : undefined;
    }
    if (platform === "win32") {
      const raw = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000, windowsHide: true }).trim();
      return raw ? `win:${raw}` : undefined;
    }
    if (platform === "darwin") {
      const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000,
      }).trim();
      return raw ? `ps:${raw}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function ownerAlive(owner, deps) {
  try { deps.kill(owner.pid, 0); }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    return true; // Unknown probe failures fail closed.
  }
  const observedKey = deps.getProcessStartKey(owner.pid);
  return observedKey === undefined || observedKey === owner.startKey;
}

function parseOwner(text) {
  try {
    const value = JSON.parse(text);
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || typeof value.startKey !== "string" || !value.startKey || typeof value.token !== "string" || !value.token) return null;
    return { pid: value.pid, startKey: value.startKey, token: value.token };
  } catch {
    return null;
  }
}

/**
 * Claim the single runtime owner slot for a data directory. A live owner with a
 * matching process-start key cannot be replaced; a dead or PID-reused owner can.
 * The returned release callback only removes the exact record this process wrote.
 */
export function acquireRuntimeOwner(dataDir, options = {}) {
  const deps = {
    pid: options.pid ?? process.pid,
    getProcessStartKey: options.getProcessStartKey ?? processStartKey,
    kill: options.kill ?? process.kill.bind(process),
    now: options.now ?? Date.now,
    exists: options.exists ?? existsSync,
    read: options.read ?? readFileSync,
    stat: options.stat ?? statSync,
    write: options.write ?? writeFileSync,
    remove: options.remove ?? rmSync,
  };
  const startKey = deps.getProcessStartKey(deps.pid);
  if (!startKey) throw new Error("runtime owner process identity is unavailable");

  const ownerPath = join(dataDir, "runtime-owner.json");
  const token = randomUUID();
  withDirectoryLock({
    lockPath: `${ownerPath}.claim`, parentDir: dataDir, staleMs: 30_000,
    busyMessage: "runtime owner claim is busy",
  }, () => {
    if (deps.exists(ownerPath)) {
      const owner = parseOwner(deps.read(ownerPath, "utf8"));
      if (owner) {
        if (ownerAlive(owner, deps)) {
          throw new Error(`runtime already owned by PID ${owner.pid}`);
        }
      } else {
        let ageMs;
        try { ageMs = deps.now() - deps.stat(ownerPath).mtimeMs; }
        catch { ageMs = INITIAL_OWNER_GRACE_MS + 1; }
        if (ageMs <= INITIAL_OWNER_GRACE_MS) throw new Error("runtime owner record is still being written");
      }
      deps.remove(ownerPath, { force: true });
    }
    deps.write(ownerPath, `${JSON.stringify({ pid: deps.pid, startKey, token })}\n`, { encoding: "utf8", flag: "wx" });
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try {
      const owner = parseOwner(deps.read(ownerPath, "utf8"));
      if (owner?.token === token) deps.remove(ownerPath, { force: true });
    } catch { /* process exit cleanup is best effort; next owner checks PID and start key */ }
  };
  process.once("exit", release);
  return release;
}
