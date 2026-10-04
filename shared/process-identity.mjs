import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Stable PID identity shared by the Host reaper and Backend child registry. */
export function processStartKey(pid, { platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
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
