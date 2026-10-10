export const LLAMA_SERVER_SETTINGS_KEY = "llama-server-config";
export const DEFAULT_LLAMA_SERVER_PORT = 8081;
export function llamaServerPort(raw) {
    const parsed = Number(String(raw ?? "").trim());
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536
        ? parsed
        : DEFAULT_LLAMA_SERVER_PORT;
}
export function llamaServerBaseUrl(raw) {
    return `http://127.0.0.1:${llamaServerPort(raw)}`;
}
/** "" = omit the kwarg entirely (models without a reasoning_effort template,
 *  e.g. Ornith-1.5). The other values are graded Qwen3 efforts. */
export const LLAMA_SERVER_EFFORTS = ["", "low", "medium", "xhigh"];
/** Speculative decoding types for the bat's SPEC_TYPE env. "" = disabled.
 *  `draft-mtp` (also when paired with ngram-mod) needs GGUFs that bundle
 *  MTP tensors (nextn_predict_layers >= 1); others fail to load. */
export const LLAMA_SERVER_SPEC_TYPES = ["", "draft-mtp", "draft-mtp,ngram-mod"];
/** KV cache quantization for the bat's CT_K / CT_V env. "" = f16 (default).
 *  q8_0 halves KV VRAM at ~0 quality cost (measured on both local models). */
export const LLAMA_CACHE_TYPES = ["", "f16", "q8_0"];
/** Bind addresses llama-server may listen on. `127.0.0.1` is the loopback-only
 *  default; `0.0.0.0` also serves LAN/Tailscale clients. */
export const LLAMA_SERVER_HOSTS = ["127.0.0.1", "0.0.0.0"];
/** Maximum UTF-16 code units accepted for the additional system prompt. */
export const LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS = 32_768;
/** System prompts travel in JSON requests, so shell metacharacters are safe. */
export function isSafeLlamaSystemPrompt(value) {
    return (typeof value === "string" &&
        value.length <= LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS &&
        !value.includes("\u0000"));
}
export const DEFAULT_LLAMA_SERVER_SYSTEM_PROMPT = [
    "回答は必ず日本語で行う。",
    "中国語（簡体字・繁体字）で回答しない。",
    "ユーザーが中国語で入力しても、日本語で回答する。",
    "引用・固有名詞・コードなど不可避な場合を除き、中国語を出力しない。",
].join(" ");
export const DEFAULT_LLAMA_SERVER_SETTINGS = {
    effort: "low",
    contextLength: 32_768,
    parallel: 1,
    systemPrompt: DEFAULT_LLAMA_SERVER_SYSTEM_PROMPT,
    llamaCppPath: "",
    modelDir: "",
    modelFile: "",
    llamaServerHost: "127.0.0.1",
    specType: "",
    cacheTypeK: "",
    cacheTypeV: "",
    mmprojPath: "",
    loraPath: "",
};
export const LLAMA_SERVER_PATH_MAX_CHARS = 400;
/**
 * On Windows these path values become env vars for scripts/llama-server-load.bat,
 * which interpolates them into a quoted command line under
 * `setlocal enabledelayedexpansion`. A `"`, `%`, `!`, `&`, `|`, `<`, `>` or `^`
 * would break out of that quoting and run arbitrary commands, so reject them at
 * the Windows trust boundary instead of trying to escape them for cmd.exe.
 */
const WINDOWS_UNSAFE_PATH_CHARS = /["%!&|<>^*?\u0000-\u001f]/;
const POSIX_UNSAFE_PATH_CHARS = /[\u0000-\u001f]/;
/** "" (= bat default) or a platform-safe path string. */
export function isSafeLlamaPathValue(value, platform = "win32") {
    if (typeof value !== "string")
        return false;
    if (value.length > LLAMA_SERVER_PATH_MAX_CHARS)
        return false;
    const unsafe = platform === "win32" ? WINDOWS_UNSAFE_PATH_CHARS : POSIX_UNSAFE_PATH_CHARS;
    return !unsafe.test(value);
}
/** "" or a `.gguf` path relative to modelDir (no drive letter, no `..`). */
export function isSafeLlamaModelFile(value, platform = "win32") {
    if (!isSafeLlamaPathValue(value, platform))
        return false;
    if (value === "")
        return true;
    if (/^[a-zA-Z]:/.test(value) || value.startsWith("\\") || value.startsWith("/")) {
        return false;
    }
    if (value.split(/[\\/]/).includes(".."))
        return false;
    return value.toLowerCase().endsWith(".gguf");
}
/**
 * Map the user-facing llama.cpp install directory to its platform binary.
 * Windows appends `\llama-server.exe`; POSIX appends `llama-server`.
 */
export function resolveLlamaServerBin(llamaCppPath, platform = "win32") {
    const trimmed = llamaCppPath.trim().replace(/[\\/]+$/, "");
    if (!trimmed)
        return "";
    if (platform !== "win32") {
        const normalized = trimmed.replaceAll("\\", "/");
        const leaf = normalized.split("/").pop() ?? "";
        return /^llama-server(?:$|[-_.])/i.test(leaf)
            ? normalized
            : `${normalized}/llama-server`;
    }
    return /\.exe$/i.test(trimmed) ? trimmed : `${trimmed}\\llama-server.exe`;
}
/**
 * Shape gate for the persisted setting. The prompt and path fields are optional
 * so configs saved before they existed still validate (parse fills the defaults).
 */
export function isLlamaServerSettings(value, platform = "win32") {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value;
    return (typeof candidate.effort === "string" &&
        LLAMA_SERVER_EFFORTS.includes(candidate.effort) &&
        typeof candidate.contextLength === "number" &&
        Number.isSafeInteger(candidate.contextLength) &&
        candidate.contextLength >= 4096 &&
        candidate.contextLength <= 1_000_000 &&
        typeof candidate.parallel === "number" &&
        Number.isSafeInteger(candidate.parallel) &&
        candidate.parallel >= 1 &&
        candidate.parallel <= 16 &&
        (candidate.systemPrompt === undefined || isSafeLlamaSystemPrompt(candidate.systemPrompt)) &&
        (candidate.llamaCppPath === undefined || isSafeLlamaPathValue(candidate.llamaCppPath, platform)) &&
        (candidate.modelDir === undefined || isSafeLlamaPathValue(candidate.modelDir, platform)) &&
        (candidate.modelFile === undefined || isSafeLlamaModelFile(candidate.modelFile, platform)) &&
        (candidate.llamaServerHost === undefined ||
            LLAMA_SERVER_HOSTS.includes(candidate.llamaServerHost)) &&
        (candidate.specType === undefined ||
            LLAMA_SERVER_SPEC_TYPES.includes(candidate.specType)) &&
        (candidate.cacheTypeK === undefined ||
            LLAMA_CACHE_TYPES.includes(candidate.cacheTypeK)) &&
        (candidate.cacheTypeV === undefined ||
            LLAMA_CACHE_TYPES.includes(candidate.cacheTypeV)) &&
        (candidate.mmprojPath === undefined || isSafeLlamaModelFile(candidate.mmprojPath, platform)) &&
        (candidate.loraPath === undefined || isSafeLlamaModelFile(candidate.loraPath, platform)));
}
export function parseLlamaServerSettings(raw, platform = "win32") {
    if (!raw)
        return DEFAULT_LLAMA_SERVER_SETTINGS;
    try {
        const value = JSON.parse(raw);
        if (!isLlamaServerSettings(value, platform))
            return DEFAULT_LLAMA_SERVER_SETTINGS;
        return {
            ...DEFAULT_LLAMA_SERVER_SETTINGS,
            ...value,
        };
    }
    catch {
        return DEFAULT_LLAMA_SERVER_SETTINGS;
    }
}
export function serializeLlamaServerSettings(value) {
    return JSON.stringify(value);
}
export const LLAMA_MODEL_PRESETS = [
    {
        key: "ornith",
        // Ornith GGUFs have no reasoning_effort kwarg and no MTP tensors:
        // graded efforts and draft-mtp both break them.
        match: /ornith/i,
        label: "Ornith-1.5 35B（バランス）",
        description: "思考なしで 111 tok/s。128K コンテキスト。通常のコーディング向け。",
        vision: true,
        settings: { effort: "", specType: "", contextLength: 131_072, cacheTypeK: "", cacheTypeV: "q8_0" },
    },
    {
        key: "ornith-thinking",
        // Ornith's native template enables thinking when no reasoning_effort kwarg
        // is supplied. Quantizing both KV sides saves memory for long thought traces.
        match: /ornith/i,
        label: "Ornith-1.5 35B（思考つき・最適化）",
        description: "モデル既定の思考つき。128K コンテキスト。KV キャッシュを K/V とも q8_0 にして省メモリ化。",
        vision: true,
        settings: { effort: "", specType: "", contextLength: 131_072, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
    },
    {
        key: "huihui-qwen38",
        // Huihui's abliterated model keeps the Qwen3.8 MTP tensors unchanged, so
        // it can use the same speculative-decoding and KV-cache tuning.
        match: /(?=.*huihui)(?=.*qwen3[._]?8)(?=.*abliterat)/i,
        label: "Huihui-Qwen3.8 27B（abliterated・最適化）",
        description: "MTP維持版。draft-mtp 推測デコード、effort low、KV キャッシュ K/V q8_0。131K コンテキスト。",
        vision: true,
        settings: { effort: "low", specType: "draft-mtp", contextLength: 131_072, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
    },
    {
        key: "orca-bonsai27",
        // OrcaBonsai is the refusal-direction LoRA published for Ternary Bonsai 2.
        // It needs the PrismML llama.cpp fork (auto-selected on Windows); the base
        // model and mmproj remain separate GGUFs and the UI resolves the adapter
        // from the model directory.
        match: /(?:orca.?bonsai|bonsai.*uncensored|uncensored.*bonsai)/i,
        label: "OrcaBonsai 27B Uncensored（Vision・最適化）",
        description: "Ternary Bonsai 2 + refusal-direction LoRA。mmproj を自動適用、low 思考、131K コンテキスト、KV キャッシュ K/V q8_0。WindowsはC:\\tools\\llama-prism-*-vulkanを自動選択。",
        vision: true,
        settings: { effort: "low", specType: "", contextLength: 131_072, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
    },
    {
        key: "qwen38-uncensored",
        // Uncensored Qwen3.8 builds ship the vision projector next to the quant,
        // so choosing this preset also resolves the mmproj in the same folder.
        match: /(?=.*qwen3[._]?8)(?=.*uncensored)/i,
        label: "Qwen3.8 27B Uncensored（vision・高速）",
        description: "画像入力を有効化（同じフォルダの mmproj を自動適用）。MTP+ngram-mod 推測デコード、effort low、KV q8_0、64K コンテキスト。",
        vision: true,
        // 131K + mmproj + MTP draft context overflows 32GB of VRAM on the R9700:
        // WDDM then spills 3-4GB to system RAM and decode drops to 12-17 tok/s.
        settings: { effort: "low", specType: "draft-mtp,ngram-mod", contextLength: 65_536, cacheTypeK: "q8_0", cacheTypeV: "q8_0" },
    },
    {
        key: "qwen38",
        // Qwen3.5-class dense builds ship an MTP head; draft-mtp is ~15x faster.
        match: /qwen3[._]?8|qwen3\.5|qwen35/i,
        label: "Qwen3.8 27B Uncensored（思考つき・高速）",
        description: "テキスト専用（mmproj なし）でプロンプトキャッシュ再利用が有効。MTP+ngram-mod 推測デコード、effort low の思考つき、KV q8_0、64K コンテキスト。",
        vision: false,
        settings: { effort: "low", specType: "draft-mtp,ngram-mod", contextLength: 65_536, cacheTypeK: "q8_0", cacheTypeV: "q8_0" }
    },
];
/** First preset whose pattern matches the model file path, if any. */
export function findLlamaModelPreset(modelFile) {
    return LLAMA_MODEL_PRESETS.find((p) => p.match.test(modelFile)) ?? null;
}
/** True when the current specType choice cannot load the given model. */
export function isLlamaSpecComboBroken(modelFile, specType) {
    return Boolean(specType) && !findLlamaModelPreset(modelFile)?.settings.specType;
}
