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

function mergeToolResult(messages: UiMessage[], toolCallId: string, output: string, isError: boolean): void {
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
    };
    return;
  }
}

export function projectPiMessages(raw: unknown[]): UiMessage[] {
  const messages: UiMessage[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) return;
    const role = asString(item.role);
    const id = asString(item.id) || `msg-${index}`;
    const createdAt = typeof item.timestamp === "number" ? item.timestamp : Date.now();

    if (role === "user") {
      const blocks = contentBlocks(item.content);
      const parts: UiPart[] = [];
      const text = typeof item.content === "string" ? item.content : textFromBlocks(blocks);
      if (text) parts.push({ id: `${id}-text`, type: "text", text });
      parts.push(...imagePartsFromBlocks(blocks, id));
      messages.push({ id, role: "user", createdAt, parts });
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
      messages.push({
        id,
        role: "assistant",
        createdAt,
        parts,
        model: asString(item.model) || undefined,
        provider: asString(item.provider) || undefined,
        error: asString(item.errorMessage) || undefined,
      });
      return;
    }

    if (role === "toolResult") {
      const callID = asString(item.toolCallId);
      const output = textFromBlocks(contentBlocks(item.content)) || asString(item.content);
      mergeToolResult(messages, callID, output, item.isError === true);
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
              output: asString(item.output),
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
