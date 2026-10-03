import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { atomicWrite } from "@/lib/extensions";

/** Must match extensions/leafcode-tts/index.ts CONFIG_FILE. */
export const TTS_CONFIG_FILE = "tts.json";

export type TtsConfigDto = {
  enabled: boolean;
  voice: string;
  rate: number;
  url: string;
};

const DEFAULT_CONFIG: TtsConfigDto = {
  enabled: false,
  voice: "",
  rate: 10,
  url: "",
};

export function ttsConfigPath(): string {
  return join(dataDir(), TTS_CONFIG_FILE);
}

function clampRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10;
  return Math.max(-10, Math.min(10, Math.trunc(value)));
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Unauthenticated access is limited to the default local AivisSpeech/VOICEVOX endpoints. */
export function isSafeUnauthenticatedTtsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" || !["10101", "50021"].includes(url.port)) return false;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return false;
    let hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
    return hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function normalizeTtsConfig(raw: Partial<TtsConfigDto> | null | undefined): TtsConfigDto {
  return {
    enabled: raw?.enabled === true,
    voice: asTrimmed(raw?.voice),
    rate: clampRate(raw?.rate),
    url: asTrimmed(raw?.url),
  };
}

export type TtsHostCapabilities = {
  hostPlatform: NodeJS.Platform;
  sapiAvailable: boolean;
};

export function ttsHostCapabilities(
  platform: NodeJS.Platform = process.platform,
): TtsHostCapabilities {
  return {
    hostPlatform: platform,
    sapiAvailable: platform === "win32",
  };
}

export type TtsSettingsDto = TtsConfigDto & TtsHostCapabilities;

export function readTtsConfig(): TtsConfigDto {
  try {
    const file = ttsConfigPath();
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TtsConfigDto>;
    return normalizeTtsConfig(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeTtsConfig(input: Partial<TtsConfigDto>): TtsConfigDto {
  const current = readTtsConfig();
  const next = normalizeTtsConfig({
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    voice: input.voice !== undefined ? input.voice : current.voice,
    rate: input.rate !== undefined ? input.rate : current.rate,
    url: input.url !== undefined ? input.url : current.url,
  });
  const body: Record<string, unknown> = {
    enabled: next.enabled,
    rate: next.rate,
  };
  if (next.voice) body.voice = next.voice;
  if (next.url) body.url = next.url;
  atomicWrite(ttsConfigPath(), `${JSON.stringify(body, null, 2)}\n`);
  return next;
}
