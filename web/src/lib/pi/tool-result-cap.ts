/**
 * Cap oversized tool output before it enters the session history.
 *
 * Pi's own tools already stop around 50k characters, but a handful of `grep` /
 * `read` / `powershell` results of that size fill a 272k-token window in a few
 * turns: the session then compacts every few minutes and the kept tail is still
 * huge, so it re-fills immediately. Capping here shrinks what the provider
 * receives *and* what compaction has to keep.
 */

/** Per text block. Multi-block text results are rare, so no shared budget. */
export const MAX_TOOL_RESULT_CHARS = 25_000;

/**
 * Scans dump far more than the agent asked for: in two real sessions `grep`
 * averaged 24k characters per call and was the single largest consumer. Their
 * fix is a narrower pattern, not a longer result — unlike `read`, where the
 * contiguous content is the point, so it keeps the larger limit.
 */
export const MAX_SCAN_RESULT_CHARS = 8_000;

const SCAN_TOOLS = new Set([
  "grep",
  "powershell",
  "bash",
  "find",
  "ls",
  "session_search",
]);

export function limitForTool(toolName: unknown): number {
  return typeof toolName === "string" && SCAN_TOOLS.has(toolName)
    ? MAX_SCAN_RESULT_CHARS
    : MAX_TOOL_RESULT_CHARS;
}

const OMISSION_NOTICE =
  "文字を省略しました。全体が必要なら範囲・パターン・件数を絞って再実行してください";

type ToolResultPart = { type?: unknown; text?: unknown };

/** Move a cut off a surrogate pair so slicing cannot emit a lone surrogate. */
function safeCut(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** Keep the head and tail so both the command echo and the conclusion survive. */
export function capToolResultText(
  text: string,
  limit = MAX_TOOL_RESULT_CHARS,
): string {
  if (text.length <= limit) return text;
  const headEnd = safeCut(text, Math.ceil(limit * 0.6));
  const tailStart = safeCut(text, text.length - (limit - headEnd));
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n\n[... ${omitted} ${OMISSION_NOTICE} ...]\n\n${
    text.slice(tailStart)
  }`;
}

/**
 * Cap every text block of a tool result.
 * Returns `null` when nothing exceeded the limit, so callers can leave the
 * original result (and its details) untouched.
 */
export function capToolResultContent<T extends ToolResultPart>(
  content: readonly T[] | undefined,
  limit = MAX_TOOL_RESULT_CHARS,
): T[] | null {
  if (!Array.isArray(content)) return null;
  let capped = false;
  const next = content.map((part) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") {
      return part;
    }
    const text = capToolResultText(part.text, limit);
    if (text === part.text) return part;
    capped = true;
    return { ...part, text };
  });
  return capped ? next : null;
}

export type AfterToolCallEvent = {
  toolCall?: { name?: unknown };
  result?: { content?: readonly ToolResultPart[] };
};

export type AfterToolCallResult =
  | { content?: readonly ToolResultPart[] }
  | undefined;

export type AfterToolCall = (
  event: AfterToolCallEvent,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult> | AfterToolCallResult;

/**
 * `afterToolCall` is `unknown` here: the SDK hook carries a much richer context
 * than the two fields this cap reads, and narrowing it would make the agent
 * type unassignable on every SDK bump.
 */
export type ToolCappableAgent = { afterToolCall?: unknown };

const installedOn = new WeakSet<ToolCappableAgent>();

/**
 * Chain the cap onto the session's existing `afterToolCall` hook so extension
 * `tool_result` handlers still run first and their content is capped too.
 * Only `content` is returned: agent-core falls back to the original
 * `details` / `usage` / `isError` for every field we leave out.
 */
export function installToolResultCap(
  agent: ToolCappableAgent | undefined,
  limitFor: (toolName: unknown) => number = limitForTool,
): void {
  if (!agent) return;
  // Re-configuring a session must not stack wrappers on the same hook.
  if (installedOn.has(agent)) return;
  installedOn.add(agent);
  const previous =
    typeof agent.afterToolCall === "function"
      ? (agent.afterToolCall as AfterToolCall).bind(agent)
      : undefined;
  const capped: AfterToolCall = async (event, signal) => {
    const hookResult = previous ? await previous(event, signal) : undefined;
    const content = hookResult?.content ?? event.result?.content;
    const cappedContent = capToolResultContent(
      content,
      limitFor(event.toolCall?.name),
    );
    if (!cappedContent) return hookResult;
    return { ...(hookResult ?? {}), content: cappedContent };
  };
  agent.afterToolCall = capped;
}
