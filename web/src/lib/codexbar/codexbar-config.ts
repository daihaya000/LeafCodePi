/**
 * Read/write %APPDATA%\\CodexBar\\config.json without dropping unknown fields.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "@/lib/codexbar/utils";
import { codexBarConfigDir } from "@/lib/codexbar/netscape-cookies";

export const DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS = 24;
export const MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS = 7 * 24;

export type CodexBarConfig = Record<string, unknown> & {
  /** Which native providers CodexBar should fetch/display. */
  enabledProviders?: string[];
  /** LeafCodePi display/fetch order; avoids CodexBar's native providerOrder key. */
  leafCodePiProviderOrder?: string[];
  openCodeGoWorkspaceId?: string | null;
  qwenCloudApiKey?: string | null;
  qwenCloudRegion?: string | null;
  syntheticApiKey?: string | null;
  openRouterApiKey?: string | null;
  commandCodeApiKey?: string | null;
  /** Auto-redeem Codex reset credits before they expire (default: false). */
  codexResetAutoConsume?: boolean;
  /** Hours before expiry that count as "about to expire" (default: 24). */
  codexResetAutoConsumeWindowHours?: number;
};

export function codexBarConfigPath(): string {
  return join(codexBarConfigDir(), "config.json");
}

export function loadCodexBarConfig(): CodexBarConfig {
  const path = codexBarConfigPath();
  if (!existsSync(path)) return {};
  try {
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CodexBarConfig;
  } catch {
    return {};
  }
}

/** Merge patch into existing config and write atomically. Preserves unknown keys. */
export function updateCodexBarConfig(
  patch: Partial<CodexBarConfig>,
): CodexBarConfig {
  const current = loadCodexBarConfig();
  const next: CodexBarConfig = { ...current, ...patch };
  atomicWriteText(codexBarConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Resolve the automatic reset window. Returns null unless auto-redeem is
 * explicitly enabled and the configured window is finite and bounded.
 */
export function codexResetAutoConsumeWindowMs(
  config: CodexBarConfig,
): number | null {
  if (config.codexResetAutoConsume !== true) return null;
  const rawHours = config.codexResetAutoConsumeWindowHours;
  const hours =
    rawHours === undefined
      ? DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS
      : typeof rawHours === "number" &&
          Number.isFinite(rawHours) &&
          rawHours > 0 &&
          rawHours <= MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS
        ? rawHours
        : null;
  if (hours === null) return null;
  const windowMs = hours * 60 * 60 * 1000;
  return Number.isFinite(windowMs) ? windowMs : null;
}

export function readConfigString(
  config: CodexBarConfig,
  key: keyof CodexBarConfig,
): string | null {
  const v = config[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
