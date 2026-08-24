export const LLAMA_SERVER_SETTINGS_KEY = "llama-server-config";

/** "" = omit the kwarg entirely (models without a reasoning_effort template,
 *  e.g. Ornith-1.5). The other values are graded Qwen3 efforts. */
export const LLAMA_SERVER_EFFORTS = ["", "low", "medium", "xhigh"] as const;
export type LlamaServerEffort = (typeof LLAMA_SERVER_EFFORTS)[number];

/** Speculative decoding types for the bat's SPEC_TYPE env. "" = disabled.
 *  `draft-mtp` needs GGUFs that bundle MTP tensors (nextn_predict_layers >= 1,
 *  e.g. Qwen3.5-class dense builds); models without them fail to load. */
export const LLAMA_SERVER_SPEC_TYPES = ["", "draft-mtp"] as const;
export type LlamaServerSpecType = (typeof LLAMA_SERVER_SPEC_TYPES)[number];

/** KV cache quantization for the bat's CT_K / CT_V env. "" = f16 (default).
 *  q8_0 halves KV VRAM at ~0 quality cost (measured on both local models). */
export const LLAMA_CACHE_TYPES = ["", "f16", "q8_0"] as const;
export type LlamaCacheType = (typeof LLAMA_CACHE_TYPES)[number];

/** Bind addresses llama-server may listen on. `127.0.0.1` is the loopback-only
 *  default; `0.0.0.0` also serves LAN/Tailscale clients. */
export const LLAMA_SERVER_HOSTS = ["127.0.0.1", "0.0.0.0"] as const;
export type LlamaServerHost = (typeof LLAMA_SERVER_HOSTS)[number];

export type LlamaServerSettings = {
  effort: LlamaServerEffort;
  contextLength: number;
  parallel: number;
  /** llama.cpp のインストール先（ディレクトリ、または llama-server.exe の絶対パス）。"" は bat の既定値。 */
  llamaCppPath: string;
  /** GGUF モデルの保存先ルート。"" は bat の既定値。 */
  modelDir: string;
  /** 起動するモデル。modelDir からの相対パス。"" は bat の既定値。 */
  modelFile: string;
  /** バインド先。127.0.0.1 = このPCのみ / 0.0.0.0 = LAN・Tailscale からも可。 */
  llamaServerHost: LlamaServerHost;
  /** 推測デコード。"draft-mtp" は MTP テンソル込み GGUF（Qwen3.5系 dense 等）専用。 */
  specType?: LlamaServerSpecType;
  /** KV キャッシュ型。"" = f16（既定）。q8_0 は VRAM 半減。 */
  cacheTypeK?: LlamaCacheType;
  cacheTypeV?: LlamaCacheType;
};

export const DEFAULT_LLAMA_SERVER_SETTINGS: LlamaServerSettings = {
  effort: "low",
  contextLength: 32_768,
  parallel: 1,
  llamaCppPath: "",
  modelDir: "",
  modelFile: "",
  llamaServerHost: "127.0.0.1",
  specType: "",
  cacheTypeK: "",
  cacheTypeV: "",
};

export const LLAMA_SERVER_PATH_MAX_CHARS = 400;

/**
 * These path values become env vars for scripts/llama-server-load.bat, which
 * interpolates them into a quoted command line under
 * `setlocal enabledelayedexpansion`. A `"`, `%`, `!`, `&`, `|`, `<`, `>` or `^`
 * would break out of that quoting and run arbitrary commands, so reject them at
 * the trust boundary instead of trying to escape them for cmd.exe.
 */
const UNSAFE_PATH_CHARS = /["%!&|<>^*?\u0000-\u001f]/;

/** "" (= bat default) or a cmd.exe-safe path string. */
export function isSafeLlamaPathValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > LLAMA_SERVER_PATH_MAX_CHARS) return false;
  return !UNSAFE_PATH_CHARS.test(value);
}

/** "" or a `.gguf` path relative to modelDir (no drive letter, no `..`). */
export function isSafeLlamaModelFile(value: unknown): value is string {
  if (!isSafeLlamaPathValue(value)) return false;
  if (value === "") return true;
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("\\") || value.startsWith("/")) {
    return false;
  }
  if (value.split(/[\\/]/).includes("..")) return false;
  return value.toLowerCase().endsWith(".gguf");
}

/**
 * Map the user-facing "llama.cpp install path" to the binary the bat runs.
 * A directory gets `\llama-server.exe` appended; an explicit `.exe` is kept.
 */
export function resolveLlamaServerBin(llamaCppPath: string): string {
  const trimmed = llamaCppPath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  return /\.exe$/i.test(trimmed) ? trimmed : `${trimmed}\\llama-server.exe`;
}

/**
 * Shape gate for the persisted setting. The three path fields are optional so a
 * config saved before they existed still validates (parse fills the defaults).
 */
export function isLlamaServerSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LlamaServerSettings>;
  return (
    typeof candidate.effort === "string" &&
    LLAMA_SERVER_EFFORTS.includes(candidate.effort as LlamaServerEffort) &&
    typeof candidate.contextLength === "number" &&
    Number.isSafeInteger(candidate.contextLength) &&
    candidate.contextLength >= 4096 &&
    candidate.contextLength <= 1_000_000 &&
    typeof candidate.parallel === "number" &&
    Number.isSafeInteger(candidate.parallel) &&
    candidate.parallel >= 1 &&
    candidate.parallel <= 16 &&
    (candidate.llamaCppPath === undefined || isSafeLlamaPathValue(candidate.llamaCppPath)) &&
    (candidate.modelDir === undefined || isSafeLlamaPathValue(candidate.modelDir)) &&
    (candidate.modelFile === undefined || isSafeLlamaModelFile(candidate.modelFile)) &&
    (candidate.llamaServerHost === undefined ||
      LLAMA_SERVER_HOSTS.includes(candidate.llamaServerHost as LlamaServerHost)) &&
    (candidate.specType === undefined ||
      LLAMA_SERVER_SPEC_TYPES.includes(candidate.specType as LlamaServerSpecType)) &&
    (candidate.cacheTypeK === undefined ||
      LLAMA_CACHE_TYPES.includes(candidate.cacheTypeK as LlamaCacheType)) &&
    (candidate.cacheTypeV === undefined ||
      LLAMA_CACHE_TYPES.includes(candidate.cacheTypeV as LlamaCacheType))
  );
}

export function parseLlamaServerSettings(raw: string | null | undefined): LlamaServerSettings {
  if (!raw) return DEFAULT_LLAMA_SERVER_SETTINGS;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isLlamaServerSettings(value)) return DEFAULT_LLAMA_SERVER_SETTINGS;
    return {
      ...DEFAULT_LLAMA_SERVER_SETTINGS,
      ...(value as Partial<LlamaServerSettings>),
    };
  } catch {
    return DEFAULT_LLAMA_SERVER_SETTINGS;
  }
}

export function serializeLlamaServerSettings(value: LlamaServerSettings): string {
  return JSON.stringify(value);
}

/** Recommended launch settings for a known local model family. */
export type LlamaModelPreset = {
  /** Stable select value. */
  key: "ornith" | "ornith-thinking" | "qwen38";
  /** Matches the model file path (case-insensitive). */
  match: RegExp;
  label: string;
  description: string;
  settings: Pick<
    LlamaServerSettings,
    "effort" | "specType" | "contextLength" | "cacheTypeK" | "cacheTypeV"
  >;
};

export const LLAMA_MODEL_PRESETS: readonly LlamaModelPreset[] = [
  {
    key: "ornith",
    // Ornith GGUFs have no reasoning_effort kwarg and no MTP tensors:
    // graded efforts and draft-mtp both break them.
    match: /ornith/i,
    label: "Ornith-1.5 35B（バランス）",
    description: "思考なしで 111 tok/s。128K コンテキスト。通常のコーディング向け。",
    settings: { effort: "", specType: "", contextLength: 131_072, cacheTypeK: "", cacheTypeV: "q8_0" },
  },
  {
    key: "ornith-thinking",
    // Ornith's native template enables thinking when no reasoning_effort kwarg
    // is supplied. Quantizing both KV sides saves memory for long thought traces.
    match: /ornith/i,
    label: "Ornith-1.5 35B（思考つき・最適化）",
    description: "モデル既定の思考つき。128K コンテキスト。KV キャッシュを K/V とも q8_0 にして省メモリ化。",
    settings: { effort: "", specType: "", contextLength: 131_072, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
  },
  {
    key: "qwen38",
    // Qwen3.5-class dense builds ship an MTP head; draft-mtp is ~15x faster.
    match: /qwen3[._]?8|qwen3\.5|qwen35/i,
    label: "Qwen3.8 27B（思考つき・高速）",
    description: "draft-mtp 推測デコードで 68 tok/s。effort low の思考つき。",
    settings: { effort: "low", specType: "draft-mtp", contextLength: 131_072, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
  },
];

/** First preset whose pattern matches the model file path, if any. */
export function findLlamaModelPreset(modelFile: string): LlamaModelPreset | null {
  return LLAMA_MODEL_PRESETS.find((p) => p.match.test(modelFile)) ?? null;
}

/** True when the current specType choice cannot load the given model. */
export function isLlamaSpecComboBroken(modelFile: string, specType?: string): boolean {
  return Boolean(specType) && !findLlamaModelPreset(modelFile)?.settings.specType;
}
