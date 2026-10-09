export declare const LLAMA_SERVER_SETTINGS_KEY = "llama-server-config";
export declare const DEFAULT_LLAMA_SERVER_PORT = 8081;
export declare function llamaServerPort(raw: unknown): number;
export declare function llamaServerBaseUrl(raw: unknown): string;
/** "" = omit the kwarg entirely (models without a reasoning_effort template,
 *  e.g. Ornith-1.5). The other values are graded Qwen3 efforts. */
export declare const LLAMA_SERVER_EFFORTS: readonly ["", "low", "medium", "xhigh"];
export type LlamaServerEffort = (typeof LLAMA_SERVER_EFFORTS)[number];
/** Speculative decoding types for the bat's SPEC_TYPE env. "" = disabled.
 *  `draft-mtp` (also when paired with ngram-mod) needs GGUFs that bundle
 *  MTP tensors (nextn_predict_layers >= 1); others fail to load. */
export declare const LLAMA_SERVER_SPEC_TYPES: readonly ["", "draft-mtp", "draft-mtp,ngram-mod"];
export type LlamaServerSpecType = (typeof LLAMA_SERVER_SPEC_TYPES)[number];
/** KV cache quantization for the bat's CT_K / CT_V env. "" = f16 (default).
 *  q8_0 halves KV VRAM at ~0 quality cost (measured on both local models). */
export declare const LLAMA_CACHE_TYPES: readonly ["", "f16", "q8_0"];
export type LlamaCacheType = (typeof LLAMA_CACHE_TYPES)[number];
/** Bind addresses llama-server may listen on. `127.0.0.1` is the loopback-only
 *  default; `0.0.0.0` also serves LAN/Tailscale clients. */
export declare const LLAMA_SERVER_HOSTS: readonly ["127.0.0.1", "0.0.0.0"];
export type LlamaServerHost = (typeof LLAMA_SERVER_HOSTS)[number];
/** Maximum UTF-16 code units accepted for the additional system prompt. */
export declare const LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS = 32768;
/** System prompts travel in JSON requests, so shell metacharacters are safe. */
export declare function isSafeLlamaSystemPrompt(value: unknown): value is string;
export type LlamaServerSettings = {
    effort: LlamaServerEffort;
    contextLength: number;
    parallel: number;
    /** llama-server リクエストへ追加するシステムプロンプト。"" は追加なし。 */
    systemPrompt: string;
    /** llama.cpp のインストール先ディレクトリ。"" はOS別の既定値。 */
    llamaCppPath: string;
    /** GGUF モデルの保存先ルート。"" はOS別の既定値。 */
    modelDir: string;
    /** 起動するモデル。modelDir からの相対パス。"" はOS別の既定値。 */
    modelFile: string;
    /** バインド先。127.0.0.1 = このPCのみ / 0.0.0.0 = LAN・Tailscale からも可。 */
    llamaServerHost: LlamaServerHost;
    /** 推測デコード。draft-mtp 系は MTP テンソル込み GGUF 専用。 */
    specType?: LlamaServerSpecType;
    /** KV キャッシュ型。"" = f16（既定）。q8_0 は VRAM 半減。 */
    cacheTypeK?: LlamaCacheType;
    cacheTypeV?: LlamaCacheType;
    /** Vision projector (mmproj) の GGUF。modelDir からの相対パス。"" = 画像入力なし。 */
    mmprojPath?: string;
    /** LoRA adapter の GGUF。modelDir からの相対パス。"" = adapterなし。 */
    loraPath?: string;
};
export declare const DEFAULT_LLAMA_SERVER_SYSTEM_PROMPT: string;
export declare const DEFAULT_LLAMA_SERVER_SETTINGS: LlamaServerSettings;
export declare const LLAMA_SERVER_PATH_MAX_CHARS = 400;
/** "" (= bat default) or a platform-safe path string. */
export declare function isSafeLlamaPathValue(value: unknown, platform?: string): value is string;
/** "" or a `.gguf` path relative to modelDir (no drive letter, no `..`). */
export declare function isSafeLlamaModelFile(value: unknown, platform?: string): value is string;
/**
 * Map the user-facing llama.cpp install directory to its platform binary.
 * Windows appends `\llama-server.exe`; POSIX appends `llama-server`.
 */
export declare function resolveLlamaServerBin(llamaCppPath: string, platform?: string): string;
/**
 * Shape gate for the persisted setting. The prompt and path fields are optional
 * so configs saved before they existed still validate (parse fills the defaults).
 */
export declare function isLlamaServerSettings(value: unknown, platform?: string): boolean;
export declare function parseLlamaServerSettings(raw: string | null | undefined, platform?: string): LlamaServerSettings;
export declare function serializeLlamaServerSettings(value: LlamaServerSettings): string;
/** Recommended launch settings for a known local model family. */
export type LlamaModelPreset = {
    /** Stable select value. */
    key: "ornith" | "ornith-thinking" | "huihui-qwen38" | "qwen38-uncensored" | "qwen38" | "orca-bonsai27";
    /** Matches the model file path (case-insensitive). */
    match: RegExp;
    label: string;
    description: string;
    /** Apply the model's mmproj (image input). False keeps the launch text-only,
     *  which also re-enables llama-server's prompt cache reuse (multimodal
     *  launches disable it), so text-only presets restore long prompts faster. */
    vision: boolean;
    settings: Pick<LlamaServerSettings, "effort" | "specType" | "contextLength" | "cacheTypeK" | "cacheTypeV">;
};
export declare const LLAMA_MODEL_PRESETS: readonly LlamaModelPreset[];
/** First preset whose pattern matches the model file path, if any. */
export declare function findLlamaModelPreset(modelFile: string): LlamaModelPreset | null;
/** True when the current specType choice cannot load the given model. */
export declare function isLlamaSpecComboBroken(modelFile: string, specType?: string): boolean;
