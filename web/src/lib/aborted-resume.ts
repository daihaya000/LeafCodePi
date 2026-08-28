import type { UiMessage } from "./types";

/**
 * 途中で終わったターンを再開するための判定ロジック。
 *
 * 対象は 2 種類。
 * - `aborted`: ユーザー停止・ハング watchdog による停止などで中断されたターン。
 * - `silent`: エージェントが応答本文を返さずターンを終えた場合（無言終了）。
 *
 * React/browser API を持ち込まないので、TaskView のレンダリングと単体テストの
 * どちらからでも同じ判定を使える。
 */

/** OpenCode 互換の中断 error 名（Pi では文字列 error に含まれる場合もある）。 */
export const MESSAGE_ABORTED_ERROR = "MessageAbortedError";

/** 再開を提示する理由。UI の文言と aria-label を分けるために使う。 */
export type ResumeReason = "aborted" | "silent";

export type ResumableTurn = {
  reason: ResumeReason;
  /** 中断/無言終了した assistant メッセージ ID。UI の表示位置判定に使う。 */
  messageId: string;
  /** 再送するプロンプト本文。 */
  text: string;
  /** 元のプロンプトに添付されていた画像。 */
  files: { uri: string; mime: string; name?: string }[];
  /** そのターンのモデル（あれば同じモデルで再送する）。 */
  model?: { providerID: string; modelID: string };
};

export type FindResumableTurnOptions = {
  /** POST /abort 直後に harness が記録した assistant メッセージ ID。 */
  manualAbortedAssistantId?: string | null;
};

export function shouldAutoResumeSilentTurn(input: {
  target: ResumableTurn | null;
  showResume: boolean;
  sessionHydrating: boolean;
  compacting: boolean;
  sseReconnecting: boolean;
  taskStatus?: string;
  resumingTurn: boolean;
  currentPromptIsHangRetry: boolean;
}): boolean {
  return Boolean(
    input.showResume &&
      !input.sessionHydrating &&
      !input.compacting &&
      !input.sseReconnecting &&
      input.target?.reason === "silent" &&
      input.taskStatus === "idle" &&
      !input.resumingTurn &&
      !input.currentPromptIsHangRetry,
  );
}

const ABORT_ERROR_PATTERN =
  /abort|cancelled|canceled|messageabortederror/i;

/** 中断された assistant メッセージかどうか。 */
export function isAbortedAssistantMessage(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  const error = message.error?.trim();
  if (!error) return false;
  return error === MESSAGE_ABORTED_ERROR || ABORT_ERROR_PATTERN.test(error);
}

/** そのメッセージにユーザー可視のターン成果があるか。 */
function hasTurnOutput(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.error) return true;
  return message.parts.some((part) => {
    if (part.type === "text") return part.text.trim() !== "";
    return part.type === "tool" &&
      part.state.status !== "pending" &&
      part.state.status !== "running";
  });
}

/** まだ動いているツールがある（idle 誤報の隙間）。 */
function hasPendingTool(message: UiMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool" &&
      (part.state.status === "running" || part.state.status === "pending"),
  );
}

/** user メッセージの text パートを 1 つのプロンプト本文へまとめる。 */
function promptTextOf(message: UiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/** user メッセージの image パートを再送形式へ戻す。 */
function promptFilesOf(
  message: UiMessage,
): { uri: string; mime: string; name?: string }[] {
  return message.parts.flatMap((part) => {
    if (part.type !== "image" || !part.url || !part.mime) return [];
    return [
      {
        uri: part.url,
        mime: part.mime,
        ...(part.filename ? { name: part.filename } : {}),
      },
    ];
  });
}

/**
 * 会話の**現在のターン**（直近の user プロンプト以降）が中断または無言終了で
 * 終わっているなら、その再開に必要な情報を返す。
 *
 * 呼び出し側はセッションが idle であること（`working === false`）を保証すること。
 */
export function findResumableTurn(
  messages: UiMessage[],
  options?: FindResumableTurnOptions,
): ResumableTurn | null {
  let promptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return null;

  const prompt = messages[promptIndex];
  const turnStart = promptIndex + 1;
  const turnLength = messages.length - turnStart;
  if (!prompt) return null;

  const text = promptTextOf(prompt);
  if (!text) return null;

  const manualRaw = options?.manualAbortedAssistantId;
  // 手動停止が応答生成開始前だと assistant メッセージが 1 件も無い。harness は
  // その場合 manualAbortedAssistantId に空文字を入れるので、それを目印に
  // プロンプト自体を再開対象にする（aborted 扱いで自動再開はしない）。
  if (manualRaw !== undefined && manualRaw !== null && !manualRaw.trim() && turnLength === 0) {
    return {
      reason: "aborted",
      messageId: prompt.id,
      text,
      files: promptFilesOf(prompt),
    };
  }
  if (turnLength === 0) return null;

  const build = (
    source: UiMessage,
    reason: ResumeReason,
  ): ResumableTurn => ({
    reason,
    messageId: source.id,
    text,
    files: promptFilesOf(prompt),
    ...(source.provider && source.model
      ? { model: { providerID: source.provider, modelID: source.model } }
      : {}),
  });

  const manualId = manualRaw?.trim();
  if (manualId) {
    let manualIndex = -1;
    for (let i = turnStart; i < messages.length; i += 1) {
      if (messages[i]?.id === manualId) {
        manualIndex = i;
        break;
      }
    }
    if (manualIndex >= 0) {
      for (let i = manualIndex + 1; i < messages.length; i += 1) {
        const message = messages[i];
        if (message && hasTurnOutput(message)) return null;
      }
      return build(messages[manualIndex]!, "aborted");
    }
  }

  let lastAbort = -1;
  for (let i = messages.length - 1; i >= turnStart; i -= 1) {
    const message = messages[i];
    if (message && isAbortedAssistantMessage(message)) {
      lastAbort = i;
      break;
    }
  }
  if (lastAbort >= 0) {
    for (let i = lastAbort + 1; i < messages.length; i += 1) {
      const message = messages[i];
      if (message && hasTurnOutput(message)) return null;
    }
    return build(messages[lastAbort]!, "aborted");
  }

  for (let i = turnStart; i < messages.length; i += 1) {
    const message = messages[i];
    if (message && (hasTurnOutput(message) || hasPendingTool(message))) return null;
  }
  return build(messages[messages.length - 1]!, "silent");
}

/** ターンにユーザー可視の応答があるか（watchdog 用）。 */
export function turnHasAssistantResponse(messages: UiMessage[], startedAtMs: number): boolean {
  let promptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.createdAt >= startedAtMs) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") {
        promptIndex = i;
        break;
      }
    }
  }
  if (promptIndex < 0) return false;
  return messages.slice(promptIndex + 1).some(hasTurnOutput);
}

/** 走行中ツールがあるか（watchdog 用）。 */
export function turnHasActiveTool(messages: UiMessage[], startedAtMs: number): boolean {
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.createdAt >= startedAtMs) {
      from = i + 1;
      break;
    }
  }
  return messages.slice(from).some(hasPendingTool);
}
