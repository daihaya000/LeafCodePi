/**
 * CodexBar enabledProviders catalog + helpers (LeafCode addon port).
 * Safe catalog only — never expose credentials from config.json.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import {
  codexBarConfigPath,
  loadCodexBarConfig,
  type CodexBarConfig,
} from "@/lib/codexbar/codexbar-config";

export const PROVIDER_CATALOG = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
  { id: "commandcode", name: "Command Code" },
  { id: "opencode-go", name: "OpenCode" },
  { id: "ollama", name: "Ollama" },
  { id: "cursor", name: "Cursor" },
  { id: "qwen-cloud", name: "Qwen Cloud" },
  { id: "synthetic", name: "Synthetic" },
  { id: "openrouter", name: "OpenRouter" },
] as const;

export type ProviderId = (typeof PROVIDER_CATALOG)[number]["id"];

export type CatalogProvider = (typeof PROVIDER_CATALOG)[number] & {
  enabled: boolean;
  configurable: boolean;
};

export const DEFAULT_ENABLED: ProviderId[] = ["codex", "claude", "cursor"];

const providerIds = new Set<string>(PROVIDER_CATALOG.map((p) => p.id));

export class ProviderConfigError extends Error {}

/** SHA-256 hex of config file text (optimistic concurrency token). */
export function versionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Version used when config.json is absent (GET defaults / first PUT). */
export const MISSING_CONFIG_TEXT = "{}";

export function parseEnabledProviders(
  config: Record<string, unknown>,
): ProviderId[] {
  const raw = config.enabledProviders;
  if (raw === undefined) return [...DEFAULT_ENABLED];
  if (
    !Array.isArray(raw) ||
    raw.some((id) => typeof id !== "string" || !providerIds.has(id))
  ) {
    throw new ProviderConfigError("CodexBar のプロバイダー設定が不正です");
  }
  return [...new Set(raw)] as ProviderId[];
}

/**
 * Soft resolve for native fetch / snapshot filter.
 * Missing file → defaults. Invalid enabledProviders → defaults (do not break usage).
 */
export function resolveEnabledProviderIds(): ProviderId[] {
  const path = codexBarConfigPath();
  if (!existsSync(path)) return [...DEFAULT_ENABLED];
  try {
    const config = loadCodexBarConfig();
    return parseEnabledProviders(config);
  } catch {
    return [...DEFAULT_ENABLED];
  }
}

export function catalog(enabled: readonly ProviderId[]): CatalogProvider[] {
  const active = new Set(enabled);
  return PROVIDER_CATALOG.map((provider) => ({
    ...provider,
    enabled: active.has(provider.id),
    configurable: true,
  }));
}

/** Catalog order, filtered to the enabled set (deduped). */
export function orderEnabledProviders(enabled: Iterable<string>): ProviderId[] {
  const active = new Set(enabled);
  return PROVIDER_CATALOG.map((p) => p.id).filter((id) => active.has(id));
}

export function isKnownProviderId(id: string): id is ProviderId {
  return providerIds.has(id);
}

type ConfigFile = Record<string, unknown>;

function isConfigFile(value: unknown): value is ConfigFile {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type ReadConfigResult = {
  text: string;
  config: ConfigFile;
  enabled: ProviderId[];
  /** True when config.json was absent; version is hash of "{}". */
  missing: boolean;
};

/**
 * Strict read for the providers API.
 * Missing file → soft defaults with text="{}" (no credentials invented).
 * Malformed / unsafe path → throws ProviderConfigError.
 */
export async function readProviderConfig(): Promise<ReadConfigResult> {
  const file = codexBarConfigPath();
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProviderConfigError(
        "CodexBar の設定ファイルを安全に読み込めません",
      );
    }
    text = await fs.readFile(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return {
        text: MISSING_CONFIG_TEXT,
        config: {},
        enabled: [...DEFAULT_ENABLED],
        missing: true,
      };
    }
    throw new ProviderConfigError("CodexBar の設定ファイルを読み込めません");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderConfigError("CodexBar の設定ファイルが不正です");
  }
  if (!isConfigFile(value)) {
    throw new ProviderConfigError("CodexBar の設定ファイルが不正です");
  }

  return {
    text,
    config: value,
    enabled: parseEnabledProviders(value),
    missing: false,
  };
}

/** Patch type for documentation; config may hold more keys. */
export type CodexBarConfigWithProviders = CodexBarConfig & {
  enabledProviders?: ProviderId[];
};
