export type NotifyKind = "attention" | "done";

export type NotifyDecisionInput = {
  /** Previous / current "needs approval or question" flag. */
  prevAttention: boolean;
  attention: boolean;
  /** Previous / current "agent is working" flag. */
  prevWorking: boolean;
  working: boolean;
  /** Whether the tab is currently hidden/unfocused. */
  documentHidden: boolean;
  permission: NotificationPermission;
};

/**
 * Decide whether to raise a desktop notification, purely from state
 * transitions. Only notifies when permission is granted and the tab is not
 * focused, so foreground users are never spammed.
 */
export function decideNotification(i: NotifyDecisionInput): NotifyKind | null {
  if (i.permission !== "granted") return null;
  if (!i.documentHidden) return null;
  // Rising edge into "needs attention" wins over completion.
  if (!i.prevAttention && i.attention) return "attention";
  // Falling edge out of "working" with nothing pending = task done.
  if (i.prevWorking && !i.working && !i.attention) return "done";
  return null;
}

export function notificationText(
  kind: NotifyKind,
  title: string,
): { title: string; body: string } {
  const name = title || "LeafCode タスク";
  return kind === "attention"
    ? { title: "承認が必要です", body: name }
    : { title: "タスクが完了しました", body: name };
}

/** 失敗理由はプロバイダの生エラーを含みうるので、通知本文に収まる長さへ切る。 */
export const MAX_ROUTINE_ERROR_CHARS = 200;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}\u2026` : text;
}

/** ルーティン実行結果の通知文言。失敗は理由、成功は返信の頭を見せる。 */
export function routineRunNotificationText(run: {
  botName: string;
  routineName: string;
  ok: boolean;
  preview?: string | null;
  error?: string | null;
  autoDisabled?: boolean;
}): { title: string; body: string } {
  const label = `${run.botName || "Bot"}・${run.routineName || "ルーティン"}`;
  if (run.ok) {
    return {
      title: "ルーティン完了",
      body: run.preview ? `${label}\n${run.preview}` : label,
    };
  }
  return {
    title: run.autoDisabled ? "ルーティン失敗（自動無効化）" : "ルーティン失敗",
    body: `${label}\n${clip(run.error || "実行に失敗しました", MAX_ROUTINE_ERROR_CHARS)}`,
  };
}

/** Bot タブを開いている画面では BotView が音と通知を担うので、全体通知は出さない。 */
export function isRoutineRunHandledInline(
  pathname: string | null | undefined,
  botId: string,
): boolean {
  return Boolean(botId) && pathname === `/bots/${botId}`;
}
