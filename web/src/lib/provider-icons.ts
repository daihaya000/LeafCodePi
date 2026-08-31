/**
 * Brand icons for Pi / OpenCode-style provider ids.
 * Files live under web/public/icons and are served as /icons/….
 */

const PROVIDER_ICON_FILES: Record<string, string> = {
  // Canonical brand keys
  codex: "codex.png",
  claude: "claude.png",
  cursor: "cursor.png",
  ollama: "ollama.png",
  opencode: "opencode.png",
  openrouter: "openrouter.svg",
  qwen: "qwen.png",
  synthetic: "synthetic.png",
  lmstudio: "lmstudio.png",
  "llama-server": "llama-server.png",
  commandcode: "commandcode.svg",
  leafcode: "leafcode.png",
  leafcodegreen: "leafcodegreen.png",
};

/** Map Pi provider ids → bundled icon file key. */
const PROVIDER_ID_TO_ICON: Record<string, string> = {
  anthropic: "claude",
  claude: "claude",
  openai: "codex",
  "openai-codex": "codex",
  codex: "codex",
  cursor: "cursor",
  ollama: "ollama",
  "ollama-cloud": "ollama",
  opencode: "opencode",
  "opencode-go": "opencode",
  openrouter: "openrouter",
  qwen: "qwen",
  "qwen-cloud": "qwen",
  "qwen-token-plan": "qwen",
  "qwen-token-plan-cn": "qwen",
  "qwen-token-plan-individual": "qwen",
  synthetic: "synthetic",
  lmstudio: "lmstudio",
  "llama-server": "llama-server",
  commandcode: "commandcode",
  "command-code": "commandcode",
  auto: "leafcode",
  leafcodecloud: "leafcodegreen",
};

/** Public path of a brand icon for a provider id, or null. */
export function providerIconSrc(providerId: string): string | null {
  const id = providerId.trim().toLowerCase();
  if (!id) return null;
  const key = PROVIDER_ID_TO_ICON[id] ?? (PROVIDER_ICON_FILES[id] ? id : null);
  if (!key) return null;
  const file = PROVIDER_ICON_FILES[key];
  return file ? `/icons/${file}` : null;
}

export function providerIconSrcForModelValue(value: string): string | null {
  const separator = value.indexOf("::");
  if (separator <= 0) return providerIconSrc(value);
  return providerIconSrc(value.slice(0, separator));
}
