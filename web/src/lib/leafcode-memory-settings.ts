import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolvePiAgentDir, type AgentsMdEnv } from "@/lib/agents-md";
import {
  DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  parseLeafCodeMemorySettings,
  type LeafCodeMemorySettings,
  type LeafCodeMemorySettingsSnapshot,
} from "@/lib/leafcode-memory-schema";

export {
  DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  MEMORY_SETTING_LIMITS,
  parseLeafCodeMemorySettings,
} from "@/lib/leafcode-memory-schema";
export type {
  LeafCodeMemorySettings,
  LeafCodeMemorySettingsSnapshot,
} from "@/lib/leafcode-memory-schema";

const MAX_CONFIG_BYTES = 64 * 1024;

function settingError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function leafCodeMemoryConfigPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), "leafcode-memory-config.json");
}

function readRoot(path: string): { root: Record<string, unknown> | null; exists: boolean; error?: string } {
  if (!existsSync(path)) return { root: {}, exists: false };
  if (lstatSync(path).isSymbolicLink()) return { root: null, exists: true, error: "設定ファイルがシンボリックリンクのため編集できません" };
  if (!statSync(path).isFile() || statSync(path).size > MAX_CONFIG_BYTES) {
    return { root: null, exists: true, error: "設定ファイルを安全に読み込めません" };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed)
      ? { root: parsed, exists: true }
      : { root: null, exists: true, error: "設定はJSONオブジェクトである必要があります" };
  } catch {
    return { root: null, exists: true, error: "設定ファイルのJSONを解析できません" };
  }
}

function settingsFromRoot(root: Record<string, unknown>) {
  const sessionSearch = isRecord(root.sessionSearch) ? root.sessionSearch : {};
  const parsed = parseLeafCodeMemorySettings({
    ...root,
    sessionSearchVariant: sessionSearch.variant,
  });
  if (root.sessionSearch !== undefined && !isRecord(root.sessionSearch)) {
    parsed.errors.unshift("sessionSearch が不正です");
  }
  return parsed;
}

export function readLeafCodeMemorySettings(env: AgentsMdEnv = process.env): LeafCodeMemorySettingsSnapshot {
  const path = leafCodeMemoryConfigPath(env);
  const source = readRoot(path);
  if (!source.root) {
    return {
      settings: { ...DEFAULT_LEAFCODE_MEMORY_SETTINGS },
      path,
      exists: source.exists,
      valid: false,
      writable: false,
      error: source.error,
    };
  }
  const parsed = settingsFromRoot(source.root);
  return {
    settings: parsed.settings,
    path,
    exists: source.exists,
    valid: parsed.errors.length === 0,
    writable: true,
    error: parsed.errors[0],
  };
}

function validatedInput(value: unknown): LeafCodeMemorySettings {
  const parsed = parseLeafCodeMemorySettings(value);
  if (parsed.errors.length > 0 || !isRecord(value)) throw settingError(parsed.errors[0] ?? "設定が不正です");
  for (const key of Object.keys(DEFAULT_LEAFCODE_MEMORY_SETTINGS)) {
    if (!(key in value)) throw settingError(`${key} が必要です`);
  }
  return parsed.settings;
}

export function writeLeafCodeMemorySettings(
  value: unknown,
  env: AgentsMdEnv = process.env,
): LeafCodeMemorySettingsSnapshot {
  const settings = validatedInput(value);
  const path = leafCodeMemoryConfigPath(env);
  const source = readRoot(path);
  if (!source.root) throw settingError(source.error ?? "設定ファイルを編集できません", 409);
  const sessionSearch = isRecord(source.root.sessionSearch) ? source.root.sessionSearch : {};
  const next: Record<string, unknown> = {
    ...source.root,
    ...settings,
    sessionSearch: { ...sessionSearch, variant: settings.sessionSearchVariant },
    autoConsolidate: settings.memoryOverflowStrategy === "auto-consolidate",
  };
  delete next.sessionSearchVariant;

  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.leafcode-memory.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return readLeafCodeMemorySettings(env);
}
