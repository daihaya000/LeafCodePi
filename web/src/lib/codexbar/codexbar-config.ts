/**
 * Read/write CodexBar config.json without dropping unknown fields.
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
  /** @deprecated Ignored. Automatic resets are configured per account in accounts.json. */
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

/** Invalid expiry windows fall back to 24 hours, without disabling the feature. */
export function codexResetAutoConsumeWindowMs(
  config: CodexBarConfig,
): number {
  const rawHours = config.codexResetAutoConsumeWindowHours;
  const hours =
    typeof rawHours === "number" &&
    Number.isFinite(rawHours) &&
    rawHours > 0 &&
    rawHours <= MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS
      ? rawHours
      : DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS;
  return hours * 60 * 60 * 1000;
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
