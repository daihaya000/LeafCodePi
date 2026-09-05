import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import {
  atomicWrite,
  readExtensionsState,
  writeExtensionsState,
} from "@/lib/extensions";

/** Must match extensions/leafcode-commit-guard/index.ts CONFIG_FILE. */
export const COMMIT_GUARD_CONFIG_FILE = "commit-guard.json";
export const COMMIT_GUARD_EXTENSION_NAME = "leafcode-commit-guard";
export const DEFAULT_COMMIT_GUARD_ENABLED = true;

type StoredConfig = {
  enabled: boolean;
};

export function commitGuardConfigPath(): string {
  return join(dataDir(), COMMIT_GUARD_CONFIG_FILE);
}

function parseEnabled(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStoredConfig(): StoredConfig | null {
  try {
    const file = commitGuardConfigPath();
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
    const enabled = parseEnabled(raw.enabled);
    return enabled === undefined ? null : { enabled };
  } catch {
    return null;
  }
}

function clearStaleExtensionDisable(): void {
  const state = readExtensionsState();
  if (state.disabled[COMMIT_GUARD_EXTENSION_NAME] !== true) return;
  delete state.disabled[COMMIT_GUARD_EXTENSION_NAME];
  writeExtensionsState(state);
}

/**
 * Atomic: the guard extension re-reads this file on every settle and falls back
 * to enabled=true on a parse error, so a partial write would re-arm the gate.
 */
function writeConfigFile(enabled: boolean): void {
  const next: StoredConfig = { enabled: Boolean(enabled) };
  atomicWrite(commitGuardConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Stale extensions-state may still mark the required extension disabled from when
 * the settings UI toggled load/unload. Prefer that as a one-shot feature-off migration.
 */
function migrateFromExtensionsState(): boolean | null {
  const state = readExtensionsState();
  if (state.disabled[COMMIT_GUARD_EXTENSION_NAME] !== true) return null;
  writeConfigFile(false);
  delete state.disabled[COMMIT_GUARD_EXTENSION_NAME];
  writeExtensionsState(state);
  return false;
}

/** Feature toggle only — the extension package stays loaded. Default: on. */
export function readCommitGuardEnabled(): boolean {
  const stored = readStoredConfig();
  if (stored) return stored.enabled;
  const migrated = migrateFromExtensionsState();
  if (migrated !== null) return migrated;
  return DEFAULT_COMMIT_GUARD_ENABLED;
}

export function writeCommitGuardEnabled(enabled: boolean): boolean {
  const next = Boolean(enabled);
  writeConfigFile(next);
  clearStaleExtensionDisable();
  return next;
}
