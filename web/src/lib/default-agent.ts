/**
 * 既定エージェントの選択状態（Composer）。
 * 本家 LeafCode と同じく build を既定対話者にする。選択は localStorage に永続。
 */
export const DEFAULT_AGENT = "build";

const AGENT_KEY = "leafcodepi.defaultAgent";

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
