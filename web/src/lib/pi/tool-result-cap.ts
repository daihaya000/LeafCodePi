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

const OMISSION_NOTICE =
  "文字を省略しました。全体が必要なら範囲・パターン・件数を絞って再実行してください";

type ToolResultPart = { type?: unknown; text?: unknown };

/** Keep the head and tail so both the command echo and the conclusion survive. */
export function capToolResultText(
  text: string,
  limit = MAX_TOOL_RESULT_CHARS,
): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.6);
  const tail = limit - head;
  const omitted = text.length - limit;
  return `${text.slice(0, head)}\n\n[... ${omitted} ${OMISSION_NOTICE} ...]\n\n${
    text.slice(text.length - tail)
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

/**
 * Chain the cap onto the session's existing `afterToolCall` hook so extension
 * `tool_result` handlers still run first and their content is capped too.
 * Only `content` is returned: agent-core falls back to the original
 * `details` / `usage` / `isError` for every field we leave out.
 */
export function installToolResultCap(
  agent: ToolCappableAgent | undefined,
  limit = MAX_TOOL_RESULT_CHARS,
): void {
  if (!agent) return;
  const previous =
    typeof agent.afterToolCall === "function"
      ? (agent.afterToolCall as AfterToolCall).bind(agent)
      : undefined;
  const capped: AfterToolCall = async (event, signal) => {
    const hookResult = previous ? await previous(event, signal) : undefined;
    const content = hookResult?.content ?? event.result?.content;
    const cappedContent = capToolResultContent(content, limit);
    if (!cappedContent) return hookResult;
    return { ...(hookResult ?? {}), content: cappedContent };
  };
  agent.afterToolCall = capped;
}
