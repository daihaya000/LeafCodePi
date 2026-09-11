import { HANG_RETRY_PREFIX, stripHangRetryPrefix } from "../hang-retry";
import type { GoalLoopTurn, ToolState, UiDiagnostic, UiMessage, UiPart } from "../types";

export function titleFromPrompt(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "無題のタスク";
  // コードユニットではなくコードポイント単位で切る（サロゲートペアを壊さない）。
  const chars = Array.from(line);
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function diagnosticFromRaw(value: unknown): UiDiagnostic | null {
  if (!isRecord(value)) return null;
  const type = asString(value.type).trim();
  if (!type) return null;

  const rawError = isRecord(value.error) ? value.error : undefined;
  const errorMessage = rawError ? asString(rawError.message).trim() : "";
  const error = errorMessage
    ? {
        // コードポイント単位で切る（絵文字などのサロゲートペアを壊さない）。
        message: Array.from(errorMessage).slice(0, 4000).join(""),
        ...(asString(rawError?.name).trim()
          ? { name: Array.from(asString(rawError?.name).trim()).slice(0, 120).join("") }
          : {}),
        ...(typeof rawError?.code === "string" ||
        (typeof rawError?.code === "number" && Number.isFinite(rawError.code))
          ? { code: rawError.code }
          : {}),
      }
    : undefined;

  const rawDetails = isRecord(value.details) ? value.details : undefined;
  const details: NonNullable<UiDiagnostic["details"]> = {};
  for (const key of ["configuredTransport", "fallbackTransport", "phase"] as const) {
    const detail = asString(rawDetails?.[key]).trim();
    if (detail) details[key] = Array.from(detail).slice(0, 120).join("");
  }
  if (typeof rawDetails?.eventsEmitted === "boolean") {
    details.eventsEmitted = rawDetails.eventsEmitted;
  }
  if (typeof rawDetails?.requestBytes === "number" && Number.isFinite(rawDetails.requestBytes)) {
    details.requestBytes = Math.max(0, Math.round(rawDetails.requestBytes));
  }

  return {
    type: Array.from(type).slice(0, 120).join(""),
    ...(typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? { timestamp: value.timestamp }
      : {}),
    ...(error ? { error } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function diagnosticsFromRaw(value: unknown): UiDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.map(diagnosticFromRaw).filter((item): item is UiDiagnostic => item !== null);
}

const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsiEscapeSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/** Keep UI history payloads bounded; the timeline renders the same prefix only. */
export const MAX_UI_TOOL_OUTPUT_CHARS = 20_000;
export const UI_TOOL_OUTPUT_OMISSION = "\n…（以降省略）";

export function truncateUiToolOutput(text: string): string {
  return text.length > MAX_UI_TOOL_OUTPUT_CHARS
    ? `${Array.from(text).slice(0, MAX_UI_TOOL_OUTPUT_CHARS).join("")}${UI_TOOL_OUTPUT_OMISSION}`
    : text;
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
  if (typeof result === "string") return truncateUiToolOutput(stripAnsiEscapeSequences(result));
  if (!isRecord(result)) return "";
  return truncateUiToolOutput(
    stripAnsiEscapeSequences(
      textFromBlocks(contentBlocks(result.content)) || asString(result.output),
    ),
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

const GOAL_LOOP_TURN_CUSTOM_TYPE = "leafcode-goal-turn";
const GOAL_LOOP_VERIFICATION_CUSTOM_TYPE = "leafcode-goal-verification";
const GOAL_LOOP_CUSTOM_TYPES = new Set([
  GOAL_LOOP_TURN_CUSTOM_TYPE,
  GOAL_LOOP_VERIFICATION_CUSTOM_TYPE,
]);

export function isGoalLoopTurnMarker(item: unknown): boolean {
  return (
    isRecord(item) &&
    Object.prototype.hasOwnProperty.call(item, "customType") &&
    asString(item.role) === "custom" &&
    GOAL_LOOP_CUSTOM_TYPES.has(asString(item.customType))
  );
}

/** Extract only the safe turn metadata from a hidden Goal Loop marker. */
function goalLoopTurnFromRaw(item: Record<string, unknown>): GoalLoopTurn | null {
  if (!GOAL_LOOP_CUSTOM_TYPES.has(asString(item.customType))) return null;
  const details = isRecord(item.details) ? item.details : null;
  const rawTurn = details?.turn;
  const turn =
    typeof rawTurn === "number"
      ? rawTurn
      : typeof rawTurn === "string"
        ? Number(rawTurn)
        : NaN;
  const kind = details?.kind;
  if (!Number.isInteger(turn) || turn < 1 || (kind !== "goal" && kind !== "verification")) {
    return null;
  }
  const goalId = asString(details?.goalId).trim();
  return {
    ...(goalId ? { goalId } : {}),
    turn,
    kind,
  };
}

/**
 * Goal Loop custom messages carry the full LLM prompt in `content`. Only the
 * separately supplied user goal is safe to project into the WebUI timeline.
 */
function goalLoopUiPrompt(item: Record<string, unknown>): string | null {
  if (item.customType !== GOAL_LOOP_TURN_CUSTOM_TYPE) return null;
  const details = isRecord(item.details) ? item.details : null;
  const prompt = asString(details?.uiPrompt);
  return prompt.trim() ? prompt : null;
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
    role === "compactionSummary" ||
    (role === "custom" && goalLoopUiPrompt(item) !== null)
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

/**
 * セッションエントリの書き込み時刻からツール実行の開始/終了時刻を復元する。
 * ライブ計測（LiveRuntime の Map）はプロセス内にしか残らないため、再起動後の
 * 履歴はこれで埋める。assistant の message.timestamp は生成「開始」時刻で
 * モデルの生成時間を含んでしまうので、エントリ書き込み時刻を使う。
 */
export function toolTimingFromSessionEntries(entries: unknown[]): {
  startedAt: Map<string, number>;
  endedAt: Map<string, number>;
} {
  const startedAt = new Map<string, number>();
  const endedAt = new Map<string, number>();
  // 直前の assistant 応答、または一つ前のツール結果の書き込み時刻。
  // ponytail: 同一応答内の複数ツールは順次実行とみなす。並列実行でも合計の
  // 実時間は一致し、内訳だけがずれる。
  let pendingStartMs: number | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const tsMs = Date.parse(asString(entry.timestamp));
    if (!Number.isFinite(tsMs)) continue;
    const role = asString(message.role);
    if (role === "assistant") {
      pendingStartMs = tsMs;
      continue;
    }
    if (role !== "toolResult") continue;
    const callID = asString(message.toolCallId);
    if (!callID) continue;
    if (pendingStartMs !== undefined) startedAt.set(callID, pendingStartMs);
    endedAt.set(callID, tsMs);
    pendingStartMs = tsMs;
  }
  return { startedAt, endedAt };
}

export function projectPiMessages(raw: unknown[], indexOffset = 0): UiMessage[] {
  const messages: UiMessage[] = [];
  let activeGoalLoopTurn: GoalLoopTurn | undefined;
  raw.forEach((item, index) => {
    if (!isRecord(item)) return;
    const role = asString(item.role);
    const id = asString(item.id) || `msg-${index + indexOffset}`;
    const recordTsMs =
      typeof item.timestamp === "number" && Number.isFinite(item.timestamp)
        ? item.timestamp
        : undefined;
    const createdAt = recordTsMs ?? Date.now();

    if (role === "user") {
      activeGoalLoopTurn = undefined;
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

    if (role === "custom") {
      if (isGoalLoopTurnMarker(item)) {
        activeGoalLoopTurn = goalLoopTurnFromRaw(item) ?? undefined;
      }
      const text = goalLoopUiPrompt(item);
      if (text === null) return;
      messages.push({
        id,
        role: "user",
        createdAt,
        parts: [{ id: `${id}-text`, type: "text", text }],
        ...(activeGoalLoopTurn ? { goalLoopTurn: activeGoalLoopTurn } : {}),
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
      const stopReason = asString(item.stopReason);
      const error =
        errorMessage ||
        (stopReason === "aborted"
          ? "Aborted"
          : stopReason === "error"
            ? "生成が失敗しました"
            : undefined);
      const diagnostics = diagnosticsFromRaw(item.diagnostics);
      messages.push({
        id,
        role: "assistant",
        createdAt,
        parts,
        ...(activeGoalLoopTurn ? { goalLoopTurn: activeGoalLoopTurn } : {}),
        model: asString(item.model) || undefined,
        provider: asString(item.provider) || undefined,
        // Pi intentionally omits errorMessage for user aborts. Keep the
        // stopReason as a stable marker so resume remains available after a
        // session reload, not only immediately after clicking Stop.
        ...(error ? { error } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
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
        ...(activeGoalLoopTurn ? { goalLoopTurn: activeGoalLoopTurn } : {}),
        parts: [
          {
            id: `${id}-bash`,
            type: "tool",
            tool: "bash",
            callID: id,
            state: {
              status: item.cancelled === true ? "cancelled" : item.exitCode === 0 || item.exitCode == null ? "completed" : "error",
              input: { command: asString(item.command) },
              output: truncateUiToolOutput(stripAnsiEscapeSequences(asString(item.output))),
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
