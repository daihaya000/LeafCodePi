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
  rate: 0,
  url: "",
};

export function ttsConfigPath(): string {
  return join(dataDir(), TTS_CONFIG_FILE);
}

function clampRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-10, Math.min(10, Math.trunc(value)));
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTtsConfig(raw: Partial<TtsConfigDto> | null | undefined): TtsConfigDto {
  return {
    enabled: raw?.enabled === true,
    voice: asTrimmed(raw?.voice),
    rate: clampRate(raw?.rate),
    url: asTrimmed(raw?.url),
  };
}

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
