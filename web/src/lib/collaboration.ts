import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep this server-side contract in sync with extensions/leafcode-collaboration/contract.ts.
export const LEAFCODE_COLLABORATION_EXTENSION_NAME = "leafcode-collaboration" as const;
export const LEAFCODE_COLLABORATION_TOOL_NAMES = [
  "leafcode_collab",
  "leafcode_write",
  "leafcode_edit",
  "leafcode_check",
  "leafcode_commit",
] as const;
export const LEAFCODE_STRICT_BLOCKED_TOOL_NAMES = ["bash", "write", "edit"] as const;

export type CollaborationMode = "strict" | "permissive";
export type CollaborationConfigResult = {
  config: { mode: CollaborationMode };
  valid: boolean;
  error?: string;
};

function dataDir(env: NodeJS.ProcessEnv): string {
  const override = env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

export function readCollaborationConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigResult {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir(env), "collaboration.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { config: { mode: "strict" }, valid: false, error: "config must be an object" };
    }
    const mode = (raw as { mode?: unknown }).mode;
    if (mode !== "strict" && mode !== "permissive") {
      return { config: { mode: "strict" }, valid: false, error: "config.mode must be strict or permissive" };
    }
    return { config: { mode }, valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { mode: "strict" }, valid: true };
    return {
      config: { mode: "strict" },
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
