/**
 * Shared JSON name-selection parse used by Auto agent routing and Room opener.
 * Keep this tiny and behavior-stable: unknown names / extra keys are rejected.
 */

export type NamedAgentCandidate = {
  name: string;
  description?: string;
};

/** Parse `{"agent":"<exact candidate name>"}` (optional fences). Extra keys are rejected. */
export function parseNamedAgentSelection(
  raw: string,
  candidateNames: readonly string[],
): string | undefined {
  const value = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "agent") return undefined;
    const agent = (parsed as { agent?: unknown }).agent;
    if (typeof agent !== "string") return undefined;
    const name = agent.trim();
    return candidateNames.includes(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
