/**
 * Maps pi/OpenCode-style provider ids to CodexBar provider ids for models
 * whose backing subscription has usage data. Unmapped providers (local LLMs
 * etc.) simply have no rate-limit info.
 */
import type { CodexBarProvider } from "@/lib/codexbar";

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

/** Attach CodexBar usage percent / maxed flag to matching model options. */
export function attachCodexBarUsage<T extends { providerID: string }>(
  options: T[],
  providers: CodexBarProvider[],
): T[] {
  if (providers.length === 0) return options;
  const byId = new Map(providers.map((p) => [p.id, p]));
  return options.map((option) => {
    const p = byId.get(CODEXBAR_PROVIDER_MAP[option.providerID]);
    if (!p) return option;
    return {
      ...option,
      codexbarUsedPercent: p.usedPercent,
      codexbarMaxed: p.maxed,
    };
  });
}
