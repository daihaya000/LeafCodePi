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
