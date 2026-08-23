import { HANG_RETRY_PREFIX, stripHangRetryPrefix } from "../hang-retry";
import type { ToolState, UiMessage, UiPart } from "../types";

export function titleFromPrompt(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "無題のタスク";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsiEscapeSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return asString(block.text);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Tool result / partial result のテキストを UI 表示用に取り出す。 */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return stripAnsiEscapeSequences(result);
  if (!isRecord(result)) return "";
  return stripAnsiEscapeSequences(
    textFromBlocks(contentBlocks(result.content)) || asString(result.output),
  );
}

function imagePartsFromBlocks(blocks: unknown[], prefix: string): UiPart[] {
  const parts: UiPart[] = [];
  blocks.forEach((block, index) => {
    if (!isRecord(block) || block.type !== "image") return;
    const mime = asString(block.mimeType) || "image/png";
    const data = asString(block.data);
    if (!data) return;
    parts.push({
      id: `${prefix}-image-${index}`,
      type: "image",
      mime,
      url: `data:${mime};base64,${data}`,
    });
  });
  return parts;
}

/**
 * pi-subagents は tool result の `details` に実行 ID を載せる
 * （`runId` / `asyncId` / `results[].runId`）。入れ子パネルがどの実行を
 * 表示すべきか特定するために回収する。
 */
export function subagentRunIdsFromDetails(details: unknown): string[] {
  if (!isRecord(details)) return [];
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.add(value);
  };
  add(details.runId);
  add(details.asyncId);
  if (Array.isArray(details.results)) {
    for (const row of details.results) {
      if (!isRecord(row)) continue;
      add(row.runId);
      add(row.asyncId);
    }
  }
  return [...ids];
}

function mergeToolResult(
  messages: UiMessage[],
  toolCallId: string,
  output: string,
  isError: boolean,
  subagentRunIds: string[] = [],
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const part = message.parts.find(
      (item): item is Extract<UiPart, { type: "tool" }> =>
        item.type === "tool" && item.callID === toolCallId,
    );
    if (!part) continue;
    part.state = {
      ...part.state,
      status: isError ? "error" : "completed",
      output,
      error: isError ? output : undefined,
      ...(subagentRunIds.length > 0 ? { subagentRunIds } : {}),
    };
    return;
  }
}

/** projectPiMessages で独立した UiMessage になる raw（toolResult は assistant へ merge され除外）。 */
export function piRawMessageProjectsToUi(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const role = asString(item.role);
  if (role === "toolResult") return false;
  return (
    role === "user" ||
    role === "assistant" ||
    role === "bashExecution" ||
    role === "compactionSummary"
  );
}

/** projectPiMessages の出力順と同じ順で、各 UiMessage に対応するセッション entry id を返す。 */
export function entryIdsForProjectedMessages(
  raw: unknown[],
  entryIdByMessage: Map<unknown, string>,
): (string | undefined)[] {
  const ids: (string | undefined)[] = [];
  for (const item of raw) {
    if (!piRawMessageProjectsToUi(item)) continue;
    ids.push(entryIdByMessage.get(item));
  }
  return ids;
}

export function projectPiMessages(raw: unknown[]): UiMessage[] {
  const messages: UiMessage[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) return;
    const role = asString(item.role);
    const id = asString(item.id) || `msg-${index}`;
    const recordTsMs =
      typeof item.timestamp === "number" && Number.isFinite(item.timestamp)
        ? item.timestamp
        : undefined;
    const createdAt = recordTsMs ?? Date.now();

    if (role === "user") {
      const blocks = contentBlocks(item.content);
      const parts: UiPart[] = [];
      const rawText = typeof item.content === "string" ? item.content : textFromBlocks(blocks);
      const hangRetry = rawText.startsWith(HANG_RETRY_PREFIX);
      const text = hangRetry ? stripHangRetryPrefix(rawText) : rawText;
      if (text) parts.push({ id: `${id}-text`, type: "text", text });
      parts.push(...imagePartsFromBlocks(blocks, id));
      messages.push({
        id,
        role: "user",
        createdAt,
        parts,
        ...(hangRetry ? { hangRetry: true } : {}),
      });
      return;
    }

    if (role === "assistant") {
      const parts: UiPart[] = [];
      const blocks = Array.isArray(item.content) ? item.content : [];
      blocks.forEach((block, blockIndex) => {
        if (!isRecord(block)) return;
        if (block.type === "text" && asString(block.text)) {
          parts.push({ id: `${id}-text-${blockIndex}`, type: "text", text: asString(block.text) });
        }
        if (block.type === "thinking" && asString(block.thinking)) {
          parts.push({
            id: `${id}-think-${blockIndex}`,
            type: "thinking",
            text: asString(block.thinking),
          });
        }
        if (block.type === "toolCall") {
          const callID = asString(block.id) || `${id}-tool-${blockIndex}`;
          parts.push({
            id: `${id}-tool-${callID}`,
            type: "tool",
            tool: asString(block.name) || "tool",
            callID,
            state: {
              status: "running",
              input: isRecord(block.arguments) ? block.arguments : {},
              title: asString(block.name) || "tool",
            },
          });
        }
      });
      const usageOutput =
        isRecord(item.usage) &&
        typeof item.usage.output === "number" &&
        Number.isFinite(item.usage.output) &&
        item.usage.output > 0
          ? Math.round(item.usage.output)
          : undefined;
      const errorMessage = asString(item.errorMessage);
      messages.push({
        id,
        role: "assistant",
        createdAt,
        parts,
        model: asString(item.model) || undefined,
        provider: asString(item.provider) || undefined,
        // Pi intentionally omits errorMessage for user aborts. Keep the
        // stopReason as a stable marker so resume remains available after a
        // session reload, not only immediately after clicking Stop.
        error: errorMessage || (asString(item.stopReason) === "aborted" ? "Aborted" : undefined),
        ...(usageOutput !== undefined ? { outputTokens: usageOutput } : {}),
      });
      return;
    }

    if (role === "toolResult") {
      const callID = asString(item.toolCallId);
      const output = toolResultText(item);
      mergeToolResult(
        messages,
        callID,
        output,
        item.isError === true,
        subagentRunIdsFromDetails(item.details),
      );
      return;
    }

    if (role === "bashExecution") {
      messages.push({
        id,
        role: "assistant",
        createdAt,
        parts: [
          {
            id: `${id}-bash`,
            type: "tool",
            tool: "bash",
            callID: id,
            state: {
              status: item.cancelled === true ? "cancelled" : item.exitCode === 0 || item.exitCode == null ? "completed" : "error",
              input: { command: asString(item.command) },
              output: stripAnsiEscapeSequences(asString(item.output)),
              title: "bash",
            } satisfies ToolState,
          },
        ],
      });
      return;
    }

    if (role === "compactionSummary") {
      const summary = asString(item.summary);
      const tokensBefore =
        typeof item.tokensBefore === "number" && Number.isFinite(item.tokensBefore)
          ? item.tokensBefore
          : undefined;
      messages.push({
        id,
        role: "compaction",
        createdAt,
        tokensBefore,
        parts: summary ? [{ id: `${id}-text`, type: "text", text: summary }] : [],
      });
    }
  });
  return messages;
}
