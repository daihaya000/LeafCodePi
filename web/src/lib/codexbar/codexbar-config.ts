/**
 * Read/write %APPDATA%\\CodexBar\\config.json without dropping unknown fields.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "@/lib/codexbar/utils";
import { codexBarConfigDir } from "@/lib/codexbar/netscape-cookies";

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

export function readConfigString(
  config: CodexBarConfig,
  key: keyof CodexBarConfig,
): string | null {
  const v = config[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
