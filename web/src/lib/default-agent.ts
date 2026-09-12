/**
 * 既定エージェントの選択状態（Composer）。
 * 本家 LeafCode と同じく builder を既定対話者にする。選択は localStorage に永続。
 */
export const DEFAULT_AGENT = "builder";
/** Internal Composer sentinel; never pass this to the Pi session as an agent. */
export const AUTO_AGENT_VALUE = "__auto__";

const AGENT_KEY = "leafcodepi.defaultAgent";

/** Keep Composer's controlled value on Auto, build, or an available agent. */
export function resolveAgentSelection(
  preferred: string | null | undefined,
  available: readonly string[],
): string {
  const normalized = preferred?.trim() ?? "";
  if (normalized === AUTO_AGENT_VALUE) return AUTO_AGENT_VALUE;
  if (normalized && available.includes(normalized)) return normalized;
  if (available.includes(DEFAULT_AGENT)) return DEFAULT_AGENT;
  return available[0] ?? DEFAULT_AGENT;
}

export function readStoredAgent(): string {
  try {
    return localStorage.getItem(AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredAgent(agent: string): void {
  try {
    localStorage.setItem(AGENT_KEY, agent);
  } catch {
    /* private mode 等では永続できないだけ */
  }
}
