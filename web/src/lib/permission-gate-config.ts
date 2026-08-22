import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@/lib/permission-gate";

const CONFIG_DIR = ".pi/leafcode";
const CONFIG_FILE = "permission-gate.json";
/** Must match extensions/leafcode-permission-gate/index.ts SESSION_KEY. */
export const PERMISSION_GATE_SESSION_KEY = "leafcode-permission-gate";

type AgentSession = {
  extensionRunner?: { createContext: () => unknown };
};

export function permissionGateConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

/** Persist mode for the next session_start (extension reads this file on bind). */
export function writePermissionGateConfig(cwd: string, mode: PermissionMode): void {
  const file = permissionGateConfigPath(cwd);
  mkdirSync(join(cwd, CONFIG_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
}

/** Apply mode to disk and the live extension session context (if loaded). */
export function applyPermissionMode(session: AgentSession, cwd: string, mode: PermissionMode): void {
  writePermissionGateConfig(cwd, mode);
  try {
    const ctx = session.extensionRunner?.createContext();
    if (ctx && typeof ctx === "object") {
      (ctx as Record<string, unknown>)[PERMISSION_GATE_SESSION_KEY] = mode;
    }
  } catch {
    /* extension not loaded */
  }
}
