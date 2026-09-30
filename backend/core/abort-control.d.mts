export function finalAssistantIdOfCurrentTurn(messages: ReadonlyArray<{ role?: string; id?: string }>): string;
export function roomBotIdFromTaskId(taskId: string): string | null;
export function isHangWatchReplaced(
  startedAtBeforeAbort: number | undefined | null,
  watchAfterAbort: { startedAt: number } | undefined | null,
): boolean;
