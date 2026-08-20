import { execSync } from "node:child_process";
import { parseListeningPids } from "./port-plan.js";

export function runNetstat(deps = {}) {
  const exec = deps.execSync ?? execSync;
  try {
    return exec("netstat -ano", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

/**
 * @param {number} port
 * @param {{ output: string } | null} [snapshot]
 */
export function getListeningPids(port, snapshot, deps = {}) {
  const output = snapshot?.output ?? runNetstat(deps);
  if (output == null) return [];
  try {
    return parseListeningPids(output, port);
  } catch {
    return [];
  }
}
