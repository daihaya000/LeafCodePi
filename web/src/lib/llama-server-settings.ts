export const LLAMA_SERVER_SETTINGS_KEY = "llama-server-config";

export const LLAMA_SERVER_EFFORTS = ["low", "medium", "xhigh"] as const;
export type LlamaServerEffort = (typeof LLAMA_SERVER_EFFORTS)[number];

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
};

export const DEFAULT_LLAMA_SERVER_SETTINGS: LlamaServerSettings = {
  effort: "low",
  contextLength: 32_768,
  parallel: 1,
  llamaCppPath: "",
  modelDir: "",
  modelFile: "",
  llamaServerHost: "127.0.0.1",
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
      LLAMA_SERVER_HOSTS.includes(candidate.llamaServerHost as LlamaServerHost))
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
