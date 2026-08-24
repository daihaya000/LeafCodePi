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
  { id: "openai-codex", name: "Codex" },
  { id: "anthropic", name: "Claude" },
  { id: "commandcode", name: "Command Code" },
  { id: "opencode-go", name: "OpenCode" },
  { id: "ollama-cloud", name: "Ollama" },
  { id: "cursor", name: "Cursor" },
  { id: "qwen-cloud", name: "Qwen Cloud" },
  { id: "synthetic", name: "Synthetic" },
  { id: "openrouter", name: "OpenRouter" },
] as const;

export type ProviderId = (typeof PROVIDER_CATALOG)[number]["id"];

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = PROVIDER_CATALOG.map(
  (provider) => provider.id,
);

export type CatalogProvider = (typeof PROVIDER_CATALOG)[number] & {
  enabled: boolean;
  configurable: boolean;
};

export const DEFAULT_ENABLED: ProviderId[] = ["openai-codex", "anthropic", "cursor"];

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

function completeProviderOrder(order: readonly ProviderId[]): ProviderId[] {
  const seen = new Set<ProviderId>();
  const result: ProviderId[] = [];
  for (const id of [...order, ...DEFAULT_PROVIDER_ORDER]) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function parseProviderOrder(
  config: Record<string, unknown>,
  enabled: readonly ProviderId[] = parseEnabledProviders(config),
): ProviderId[] {
  const raw = config.providerOrder;
  if (raw === undefined) return completeProviderOrder(enabled);
  if (
    !Array.isArray(raw) ||
    raw.some((id) => typeof id !== "string" || !providerIds.has(id))
  ) {
    throw new ProviderConfigError("CodexBar のプロバイダー順序が不正です");
  }
  return completeProviderOrder(raw as ProviderId[]);
}

/**
 * Soft resolve for native fetch.
 * Missing file → defaults. Invalid provider settings → defaults (do not break usage).
 */
export function resolveEnabledProviderIds(): ProviderId[] {
  const path = codexBarConfigPath();
  if (!existsSync(path)) return [...DEFAULT_ENABLED];
  try {
    const config = loadCodexBarConfig();
    const enabled = parseEnabledProviders(config);
    const order = parseProviderOrder(config, enabled);
    const active = new Set(enabled);
    return order.filter((id) => active.has(id));
  } catch {
    return [...DEFAULT_ENABLED];
  }
}

export function catalog(
  enabled: readonly ProviderId[],
  order: readonly ProviderId[] = DEFAULT_PROVIDER_ORDER,
): CatalogProvider[] {
  const active = new Set(enabled);
  const byId = new Map(PROVIDER_CATALOG.map((provider) => [provider.id, provider]));
  return completeProviderOrder(order).map((id) => ({
    ...byId.get(id)!,
    enabled: active.has(id),
    configurable: true,
  }));
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
  order: ProviderId[];
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
        order: [...DEFAULT_PROVIDER_ORDER],
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
    order: parseProviderOrder(value),
    missing: false,
  };
}

/** Patch type for documentation; config may hold more keys. */
export type CodexBarConfigWithProviders = CodexBarConfig & {
  enabledProviders?: ProviderId[];
  providerOrder?: ProviderId[];
};
