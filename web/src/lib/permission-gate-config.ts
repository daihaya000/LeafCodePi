import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@/lib/permission-gate";
import { dataDir } from "@/lib/paths";

const CONFIG_FILE = "permission-gate.json";
/** Must match extensions/leafcode-permission-gate/index.ts SESSION_KEY. */
export const PERMISSION_GATE_SESSION_KEY = "leafcode-permission-gate";

type AgentSession = {
  extensionRunner?: { createContext: () => unknown };
};

/** Global WebUI state. Never create application state below a project cwd. */
export function permissionGateConfigPath(): string {
  return join(dataDir(), CONFIG_FILE);
}

/** Read persisted mode without writing. Matches extension default when missing. */
export function readPermissionGateConfig(): PermissionMode {
  try {
    const raw = JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")) as { mode?: unknown };
    if (raw.mode === "allow" || raw.mode === "ask" || raw.mode === "deny") return raw.mode;
  } catch {
    /* missing or invalid */
  }
  return "allow";
}

/** Persist mode for the next session without touching the project directory. */
export function writePermissionGateConfig(mode: PermissionMode): void {
  const file = permissionGateConfigPath();
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
}

/** Apply mode to disk and the live extension session context (if loaded). */
export function applyPermissionMode(
  session: AgentSession,
  mode: PermissionMode,
  options?: { persist?: boolean },
): void {
  if (options?.persist !== false) {
    writePermissionGateConfig(mode);
  }
  try {
    const ctx = session.extensionRunner?.createContext();
    if (ctx && typeof ctx === "object") {
      (ctx as Record<string, unknown>)[PERMISSION_GATE_SESSION_KEY] = mode;
    }
  } catch {
    /* extension not loaded */
  }
}
