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
