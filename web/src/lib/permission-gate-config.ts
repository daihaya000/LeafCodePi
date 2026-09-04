import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@/lib/permission-gate";
import { dataDir } from "@/lib/paths";
import {
  DEFAULT_SYSTEM_SAFETY_LEVEL,
  parseSystemSafetyLevel,
  systemSafetyEnabled,
  type SystemSafetyLevel,
} from "@/lib/system-safety";

const CONFIG_FILE = "permission-gate.json";
/** Must match extensions/leafcode-permission-gate/index.ts SESSION_KEY. */
export const PERMISSION_GATE_SESSION_KEY = "leafcode-permission-gate";

type StoredConfig = {
  mode: PermissionMode;
  systemSafety?: SystemSafetyLevel;
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

function safetyConfigOf(level: SystemSafetyLevel | undefined): { systemSafety?: SystemSafetyLevel } {
  return level === undefined ? {} : { systemSafety: level };
}

function readStoredConfig(): StoredConfig {
  try {
    const raw = JSON.parse(readFileSync(permissionGateConfigPath(), "utf8")) as {
      mode?: unknown;
      systemSafety?: unknown;
      sessions?: unknown;
    };
    const mode = parseMode(raw.mode) ?? "allow";
    const hasSafety = Object.prototype.hasOwnProperty.call(raw, "systemSafety");
    const systemSafety = hasSafety ? parseSystemSafetyLevel(raw.systemSafety) : undefined;
    const sessions: Record<string, PermissionMode> = {};
    if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      for (const [key, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
        const parsed = parseMode(value);
        if (parsed) sessions[key] = parsed;
      }
    }
    return Object.keys(sessions).length > 0
      ? { mode, ...safetyConfigOf(systemSafety), sessions }
      : { mode, ...safetyConfigOf(systemSafety) };
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
  const next: StoredConfig = sessionId
    ? { mode: current.mode, ...safetyConfigOf(current.systemSafety), sessions: { ...current.sessions, [sessionId]: mode } }
    : { mode, ...safetyConfigOf(current.systemSafety), sessions: current.sessions };
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

/** System safety hard-gate level. Missing config defaults to standard. */
export function readSystemSafetyLevel(): SystemSafetyLevel {
  const stored = readStoredConfig();
  return stored.systemSafety === undefined ? DEFAULT_SYSTEM_SAFETY_LEVEL : stored.systemSafety;
}

/** System safety hard-gate is on unless level is off. */
export function readSystemSafetyEnabled(): boolean {
  return systemSafetyEnabled(readSystemSafetyLevel());
}

/** Persist system-safety level without changing permission modes. */
export function writeSystemSafetyLevel(level: SystemSafetyLevel): SystemSafetyLevel {
  const file = permissionGateConfigPath();
  mkdirSync(dataDir(), { recursive: true });
  const current = readStoredConfig();
  const next: StoredConfig = {
    mode: current.mode,
    systemSafety: level,
    ...(current.sessions ? { sessions: current.sessions } : {}),
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return level;
}

/** Persist system-safety toggle without changing permission modes. */
export function writeSystemSafetyEnabled(enabled: boolean): boolean {
  writeSystemSafetyLevel(enabled ? DEFAULT_SYSTEM_SAFETY_LEVEL : "off");
  return enabled;
}
