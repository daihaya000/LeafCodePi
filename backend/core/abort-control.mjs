/**
 * Pure helpers shared by the user-stop and hang-watchdog abort paths. The
 * ordered side effects (queue clearing, SDK abort, persistence, events) stay
 * with the session owner; only decisions that need no session state live here.
 */

/**
 * Assistant id of the last reply in the current turn, or "" when no assistant
 * message exists yet. "" is the sentinel that also guards an abort issued before
 * any assistant message was produced.
 */
export function finalAssistantIdOfCurrentTurn(messages) {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return "";
  const assistants = messages.slice(promptIndex + 1).filter((message) => message.role === "assistant");
  return assistants.at(-1)?.id ?? "";
}

/** Bot id for a Room task id (`bot:<botId>:room:...`), otherwise null. */
export function roomBotIdFromTaskId(taskId) {
  return /^bot:([^:]+):room:/.exec(taskId)?.[1] ?? null;
}

/**
 * True when a newer prompt re-armed the hang watch while the abort settled, so
 * the replacement turn keeps its working state and lease.
 */
export function isHangWatchReplaced(startedAtBeforeAbort, watchAfterAbort) {
  return (
    startedAtBeforeAbort != null &&
    watchAfterAbort != null &&
    watchAfterAbort.startedAt !== startedAtBeforeAbort
  );
}
