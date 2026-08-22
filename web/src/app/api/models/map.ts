/**
 * Maps pi/OpenCode-style provider ids to CodexBar provider ids for models
 * whose backing subscription has usage data. Unmapped providers (local LLMs
 * etc.) simply have no rate-limit info.
 */
export const CODEXBAR_PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "openai-codex": "codex",
  cursor: "cursor",
  "ollama-cloud": "ollama",
  commandcode: "commandcode",
  "opencode-go": "opencode-go",
  synthetic: "synthetic",
  "qwen-cloud": "qwen-cloud",
  openrouter: "openrouter",
};
