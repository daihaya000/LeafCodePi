/**
 * Identity and liveness of a Bot Code request. Pure: the room store, the request
 * files and the message-text rules stay with the caller.
 */

/**
 * The Bot and Room a Code task was delegated from. Task ids carry the Room they
 * belong to as `bot:<botId>:room:<roomId>`; anything else is not a Room origin.
 */
export function roomCodeOrigin(taskId) {
  const match = /^bot:([^:]+):room:(.+)$/.exec(taskId ?? "");
  if (!match) return null;
  return { botId: match[1], roomId: match[2] };
}

/** Request ids are 64 lowercase hex characters (a hash, never a user-provided id). */
export function isCodeRequestId(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Whether a Room Code request may still deliver its report. The response must be the
 * Room's current turn for this Bot, its conversation must still point at the latest
 * work request, and the Bot must still be a member. `/stop` appends a user line and may
 * error-close the turn, but Code keeps running so its report can still be delivered —
 * resume stays blocked separately via the latest Room request.
 *
 * `isRoomStopRequest` is injected because the wording lives with the Room text rules.
 */
export function isRoomCodeRequestCurrent({ room, request, isRoomStopRequest }) {
  if (!request?.room) return false;
  const response = room?.messages.find((message) => message.id === request.room.responseId);
  if (!room || !response) return false;
  const requestId = request.room.conversation.requestId;
  const requestIndex = room.messages.findIndex((item) => item.id === requestId);
  const stopAfterRequest =
    requestIndex >= 0 &&
    room.messages
      .slice(requestIndex + 1)
      .some((message) => message.role === "user" && isRoomStopRequest(message.text ?? ""));
  const responseAlive = response.status !== "error" || stopAfterRequest;
  const latestWorkUser = room.messages.findLast(
    (message) => message.role === "user" && !isRoomStopRequest(message.text ?? ""),
  );
  return Boolean(
    responseAlive &&
      response.conversation?.requestId === requestId &&
      response.conversation.participantIds.includes(request.botId) &&
      latestWorkUser?.id === requestId &&
      room.members.includes(request.botId),
  );
}

/** Request states that still hold a claim on their Code task. */
export const TERMINAL_CODE_REQUEST_STATES = Object.freeze(["delivered", "cancelled"]);

/** Whether the request still holds a claim (not delivered and not cancelled). */
export function isActiveCodeRequest(request) {
  return !TERMINAL_CODE_REQUEST_STATES.includes(request?.state);
}

/**
 * The active, non-intervention request that already owns a Code task: the newest by
 * queue time, with the id as a tiebreaker so the choice is stable across readers.
 */
export function selectActiveCodeRequestForTask(requests, codeTaskId) {
  return requests
    .filter((item) => item.codeTaskId === codeTaskId && !item.userIntervention && isActiveCodeRequest(item))
    .sort((a, b) => (b.queuedAt ?? 0) - (a.queuedAt ?? 0) || b.id.localeCompare(a.id))[0];
}

/**
 * The Code tasks a Bot is still running for one origin: launch requests only, in the
 * order the requests were read. A delivered/cancelled request or a user intervention
 * never counts, and a request without a Code task id contributes nothing.
 */
export function runningCodeTaskIdsForOrigin(requests, originTaskId) {
  return requests
    .filter((item) =>
      item.originTaskId === originTaskId &&
      !item.userIntervention &&
      (item.state === "starting" || item.state === "running") &&
      item.codeTaskId,
    )
    .map((item) => item.codeTaskId);
}

/**
 * What one outbox scan does with a request the caller may act on (the lease is already
 * owned by this worker). A `starting` row whose task is no longer busy was left behind by
 * a crash, so it is re-queued and started again; a `starting` row that is still busy waits
 * for the live prompt. Anything else waits: only `queued` rows start.
 */
export function resolveOutboxScanAction({ state, isBusy }) {
  if (state === "starting") return isBusy === true ? "wait" : "requeue";
  if (state === "queued") return "start";
  return "wait";
}

/**
 * The Code task to abort when a request is cancelled. A request that never left `queued`
 * started nothing, so there is nothing to stop; a cancelled request that had reached the
 * session must have its Code task aborted.
 */
export function cancellationTargetForRequest(request) {
  if (!request || request.state === "queued") return null;
  return request.codeTaskId ?? null;
}

/**
 * The outcome and Goal Loop report a delivered Code result exposes. The delivered payload owns the
 * real outcome, so a result that does not parse as an object is treated as a legacy plain-string
 * failure and surfaced as the outcome; a parsed result contributes only a non-empty string outcome
 * and a Goal Loop report that has a status. Nothing is exposed when there is no result.
 */
export function codeRequestPayload(request) {
  const result = request?.result;
  if (!result) return {};
  try {
    const parsed = JSON.parse(result);
    return {
      ...(typeof parsed?.outcome === "string" && parsed.outcome ? { outcome: parsed.outcome } : {}),
      ...(parsed?.goalLoop && typeof parsed.goalLoop.status === "string" ? { goalLoop: parsed.goalLoop } : {}),
    };
  } catch {
    const outcome = String(result).trim();
    return outcome ? { outcome } : {};
  }
}

/**
 * The stored result of a request the user stopped. Existing object fields are kept so the report
 * still carries what the Code session produced, but the outcome is replaced by the authoritative
 * stop marker; an unreadable or non-object result becomes only that marker.
 */
export function userStoppedResult(result) {
  let payload = {};
  try {
    const parsed = JSON.parse(result ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch { /* replace an unreadable result with the authoritative stop outcome */ }
  return JSON.stringify({ ...payload, outcome: "ユーザーが停止" });
}

/**
 * The event a Code request's state change publishes. It goes to the origin task (so the Bot or Room
 * stream updates its card) and to the relay channel (so every worker's UI reacts); `codeTaskId` is
 * null until the Code task exists.
 */
export function codeSessionChangedPayload({ eventType, requestId, codeTaskId, state }) {
  return {
    type: "snapshot",
    eventType,
    codeRequestId: requestId,
    codeTaskId,
    codeState: state,
  };
}

/**
 * What a completion request does for a request in this state:
 * - "capture": a running request captures its result;
 * - "stop-and-ready": a request still starting after a user stop records the stop outcome and
 *   moves to ready, because the launch is in flight and the outcome must be durable before it
 *   settles;
 * - "stop-only": a ready request after a user stop rewrites the outcome so an in-flight delivery
 *   cannot save a success over the user's stop;
 * - "none": nothing to do (the request is gone, or its state owns its own completion).
 */
export function codeCompletionAction({ state, stoppedByUser }) {
  if (state === "running") return "capture";
  if (state === "starting" && stoppedByUser === true) return "stop-and-ready";
  if (state === "ready" && stoppedByUser === true) return "stop-only";
  return "none";
}
