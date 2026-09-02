import { execFileSync, execSync } from "node:child_process";
import {
  hasSsListeningPort,
  parseListeningPids,
  parseLsofListeningPids,
  parseSsListeningPids,
} from "./port-plan.js";

function runCommand(command, args, deps) {
  const options = {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  };
  try {
    if (deps.execFileSync) return deps.execFileSync(command, args, options);
    const exec = deps.execSync ?? execSync;
    return exec([command, ...args].join(" "), options);
  } catch (error) {
    if (
      command === "lsof" &&
      error &&
      typeof error === "object" &&
      error.status === 1 &&
      !String(error.stdout ?? "").trim() &&
      !String(error.stderr ?? "").trim()
    ) {
      return "";
    }
    throw error;
  }
}

/**
 * Return a platform-native listener snapshot. Linux prefers `ss` and falls
 * back to `lsof` when iproute2 is not installed.
 * @param {{ platform?: string, execFileSync?: Function, execSync?: Function }} [deps]
 * @param {number} [port]
 * @returns {{ output: string, format: "netstat" | "ss" | "lsof" } | null}
 */
export function runPortSnapshot(deps = {}, port) {
  const platform = deps.platform ?? process.platform;
  const candidates =
    platform === "win32"
      ? [["netstat", ["-ano"], "netstat"]]
      : [
          ["ss", ["-ltnp"], "ss"],
          [
            "lsof",
            ["-nP", "-a", "-iTCP" + (port ? `:${port}` : ""), "-sTCP:LISTEN", "-t"],
            "lsof",
          ],
        ];
  for (const [command, args, format] of candidates) {
    try {
      return { output: runCommand(command, args, deps), format };
    } catch {
      // Try the next native listener tool.
    }
  }
  return null;
}

/** Backwards-compatible name used by the Windows host. */
export function runNetstat(deps = {}) {
  return runPortSnapshot(deps)?.output ?? null;
}

/**
 * @param {number} port
 * @param {{ output: string, format?: "netstat" | "ss" | "lsof" } | null} [snapshot]
 */
export function getListeningPids(port, snapshot, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const captured = snapshot ?? runPortSnapshot(deps, port);
  if (captured == null) return [];
  const output = typeof captured === "string" ? captured : captured.output;
  const format = typeof captured === "string" ? platform : captured.format ?? platform;
  try {
    if (format === "ss") return parseSsListeningPids(output, port);
    if (format === "lsof") return parseLsofListeningPids(output, port);
    return parseListeningPids(output, port);
  } catch {
    return [];
  }
}

export function getPortListenerStatus(port, snapshot, deps = {}) {
  const captured = snapshot ?? runPortSnapshot(deps, port);
  if (captured == null) return { available: false, listening: false, pids: [] };
  const pids = getListeningPids(port, captured, deps);
  const output = typeof captured === "string" ? captured : captured.output;
  const format = typeof captured === "string"
    ? (deps.platform ?? process.platform)
    : captured.format;
  const listening = format === "ss" ? hasSsListeningPort(output, port) : pids.length > 0;
  return { available: true, listening, pids };
}
