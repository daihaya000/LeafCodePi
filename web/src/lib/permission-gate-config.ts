import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@/lib/permission-gate";
import { dataDir } from "@/lib/paths";

const CONFIG_FILE = "permission-gate.json";
/** Must match extensions/leafcode-permission-gate/index.ts SESSION_KEY. */
export const PERMISSION_GATE_SESSION_KEY = "leafcode-permission-gate";

type StoredConfig = {
  mode: PermissionMode;
  systemSafety?: boolean;
  sessions?: Record<string, PermissionMode>;
};

type AgentSession = {
  sessionId?: string | null;
  sessionManager?: { getSessionId?: () => string };
  extensionRunner?: { createContext: () => unknown };
};

function parseMode(value: unknown): PermissionMode | undefined {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return undefined;
}

function readStoredConfig(): StoredConfig {
  try {
    const raw = JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")) as {
      mode?: unknown;
      systemSafety?: unknown;
      sessions?: unknown;
    };
    const mode = parseMode(raw.mode) ?? "allow";
    const systemSafety = typeof raw.systemSafety === "boolean" ? raw.systemSafety : undefined;
    const sessions: Record<string, PermissionMode> = {};
    if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      for (const [key, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
        const parsed = parseMode(value);
        if (parsed) sessions[key] = parsed;
      }
    }
    const safetyConfig = systemSafety === undefined ? {} : { systemSafety };
    return Object.keys(sessions).length > 0
      ? { mode, ...safetyConfig, sessions }
      : { mode, ...safetyConfig };
  } catch {
    /* missing or invalid */
  }
  return { mode: "allow" };
}

function sessionIdOf(session: AgentSession): string | undefined {
  if (typeof session.sessionId === "string" && session.sessionId.trim()) {
    return session.sessionId;
  }
  try {
    const id = session.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim()) return id;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Global WebUI state. Never create application state below a project cwd. */
export function permissionGateConfigPath(): string {
  return join(dataDir(), CONFIG_FILE);
}

/** Read persisted mode without writing. Matches extension default when missing. */
export function readPermissionGateConfig(sessionId?: string | null): PermissionMode {
  const stored = readStoredConfig();
  if (sessionId && stored.sessions?.[sessionId]) return stored.sessions[sessionId];
  return stored.mode;
}

/** Persist mode for the next session without touching the project directory. */
export function writePermissionGateConfig(
  mode: PermissionMode,
  sessionId?: string | null,
): void {
  const file = permissionGateConfigPath();
  mkdirSync(dataDir(), { recursive: true });
  const current = readStoredConfig();
  const safetyConfig = current.systemSafety === undefined ? {} : { systemSafety: current.systemSafety };
  const next: StoredConfig = sessionId
    ? { mode: current.mode, ...safetyConfig, sessions: { ...current.sessions, [sessionId]: mode } }
    : { mode, ...safetyConfig, sessions: current.sessions };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Persist mode for live tool_call handlers (file-backed; ctx is ephemeral). */
export function applyPermissionMode(
  session: AgentSession,
  mode: PermissionMode,
  options?: { persist?: boolean },
): void {
  if (options?.persist === false) {
    return;
  }
  writePermissionGateConfig(mode, sessionIdOf(session));
}

/** System safety hard-gate is on unless explicitly disabled in permission-gate.json. */
export function readSystemSafetyEnabled(): boolean {
  return readStoredConfig().systemSafety !== false;
}

/** Persist system-safety toggle without changing permission modes. */
export function writeSystemSafetyEnabled(enabled: boolean): boolean {
  const file = permissionGateConfigPath();
  mkdirSync(dataDir(), { recursive: true });
  const current = readStoredConfig();
  const next: StoredConfig = {
    mode: current.mode,
    systemSafety: enabled,
    ...(current.sessions ? { sessions: current.sessions } : {}),
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return enabled;
}
