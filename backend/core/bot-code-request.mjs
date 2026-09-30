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

/**
 * The messages that belong to one Code run: everything after the request's baseline message. When
 * the baseline is gone from the transcript (revert, session reset) the correlation is broken, so the
 * run reports nothing instead of scanning the whole history and reporting an earlier answer as this
 * run's outcome.
 */
export function codeResultBaselineMessages(messages, baseline) {
  const list = Array.isArray(messages) ? messages : [];
  if (!baseline) return list;
  const baselineIndex = list.findIndex((message) => message?.id === baseline);
  return baselineIndex < 0 ? [] : list.slice(baselineIndex + 1);
}

/** The last assistant message of a run, which carries its report text. */
export function codeResultLatestAssistant(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((message) => message?.role === "assistant").at(-1);
}

/**
 * The outcome word a captured run reports. The order is the refusal precedence the UI relies on: a
 * deleted session, then the user's own stop, then a stop/abort (manual abort or an archived task),
 * then a failure (task or message error), then the Goal Loop's own verdict, then a plain finished
 * run, and finally a run that produced nothing.
 */
export function codeResultOutcome({
  hasTask,
  stoppedByUser,
  manualAborted,
  archived,
  taskError,
  messageError,
  goalLoopOutcome,
  hasText,
}) {
  if (hasTask !== true) return "セッションが削除されました";
  if (stoppedByUser === true) return "ユーザーが停止";
  if (manualAborted === true || archived === true) return "停止・中断";
  if (taskError || messageError) return "失敗";
  if (goalLoopOutcome) return goalLoopOutcome;
  return hasText === true ? "実行終了" : "結果を取得できませんでした";
}

/** The stored output text and whether it was cut at the report limit. */
export function codeResultOutput(text, maxChars) {
  const value = typeof text === "string" ? text : "";
  return {
    output: value.slice(0, maxChars),
    truncated: value.length > maxChars,
  };
}

/** How long a request waits before another delivery attempt (a busy origin keeps it queued). */
export const CODE_DELIVERY_RETRY_MS = 30_000;

/**
 * Whether a ready request may be delivered now. A busy origin (the Bot or Room is mid-turn) waits
 * so the report is not injected into a running turn, and a request that already attempted delivery
 * waits out its backoff.
 */
export function shouldAttemptCodeDelivery({ originBusy, nextAttemptAt, now }) {
  if (originBusy === true) return false;
  return !((nextAttemptAt ?? 0) > now);
}

/**
 * Whether a successful delivery may be written down. The caller re-reads the request under its lock,
 * and a request that is already delivered or cancelled must keep that state: an in-flight user stop
 * (cancelled) must not be overwritten by a stale success snapshot.
 */
export function shouldConfirmCodeDelivery({ state }) {
  return state !== "delivered" && state !== "cancelled";
}

/** Settled requests only guard tool-call replay, so they are dropped after this long. */
export const CODE_REQUEST_RETENTION_MS = 7 * 86_400_000;
/** How often the outbox is scanned. */
export const CODE_RELAY_TICK_MS = 2_000;

/**
 * Whether a request file may be deleted by the scan. Only settled requests are pruned, and only once
 * the file has been untouched for the retention window; an active request's file is never removed.
 */
export function shouldPruneCodeRequest({ isActive, fileMtimeMs, now }) {
  if (isActive === true) return false;
  if (typeof fileMtimeMs !== "number") return false;
  return now - fileMtimeMs > CODE_REQUEST_RETENTION_MS;
}

/** One scan at a time: a tick that is still running makes the next one a no-op. */
export function shouldStartCodeRelayTick({ ticking }) {
  return ticking !== true;
}

/**
 * The prompt a Bot may hand to Code, cut to the report request limit. The limit counts code points
 * (so a surrogate pair is never split) and the ellipsis is part of the limit.
 */
export function truncateCodeReportRequest(prompt, maxChars) {
  const characters = Array.from(typeof prompt === "string" ? prompt : "");
  return characters.length > maxChars
    ? `${characters.slice(0, maxChars - 1).join("")}…`
    : typeof prompt === "string" ? prompt : "";
}

/**
 * The Goal Loop options a Bot tool call may carry, validated and clamped. The shape is strict — a
 * non-object, a wrongly typed field or an unusable acceptance list is rejected with a distinct
 * message — because the tool schema is model-supplied and must not reach the store unchecked.
 * `undefined` means the caller did not ask for a loop.
 */
export function parseGoalLoopInput(value, { normalizeAcceptance, clampMaxTurns, clampCooldownSeconds, defaultMaxTurns }) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("goalLoop must be an object");
  if (
    (value.maxTurns !== undefined && typeof value.maxTurns !== "number") ||
    (value.cooldownSeconds !== undefined && typeof value.cooldownSeconds !== "number") ||
    (value.forceFullRun !== undefined && typeof value.forceFullRun !== "boolean")
  ) {
    throw new Error("invalid goalLoop");
  }
  const acceptance = normalizeAcceptance(value.acceptance);
  if (acceptance === null) throw new Error("invalid goalLoop acceptance");
  return {
    acceptance,
    maxTurns: clampMaxTurns(value.maxTurns, defaultMaxTurns),
    cooldownSeconds: clampCooldownSeconds(value.cooldownSeconds),
    forceFullRun: value.forceFullRun === true,
  };
}

/** The prompt bound a Bot tool call must respect (1 character minimum after trimming). */
export const MAX_CODE_PROMPT_CHARS = 32_000;
/** Cumulative cap on Code requests a Bot starts by itself while reporting a result. */
export const MAX_AUTO_CODE_CHAIN = 5;

/** `taskId` targets an existing session only, and never a start. */
export function codeTaskIdRefusal({ action, taskId }) {
  if (taskId === undefined) return null;
  if (typeof taskId !== "string" || !taskId.trim() || action === "start") {
    return "taskId is only supported for an existing Code session";
  }
  return null;
}

/** `goalLoop` is accepted only when starting a Code session. */
export function codeGoalLoopRefusal({ action, hasGoalLoop }) {
  return hasGoalLoop === true && action !== "start" ? "goalLoop is only supported when starting Code" : null;
}

/**
 * The gates that apply while a result is being reported: a request the user stopped may not start or
 * control Code, a Room report may not either (the Room turn owns the conversation), and only one
 * follow-up request is allowed. An abort counts against the follow-up slot because it controls a
 * session.
 */
export function codeReportingRefusal({ report, action }) {
  if (!report) return null;
  if (report.userStopped) {
    return "The user stopped this Code request. Do not start or control Code; report the stop instead.";
  }
  if (report.room) return "Result reporting cannot start or control Code. Wait for a new user instruction.";
  if (report.followUpStarted || action === "abort") {
    return "Only one follow-up Code request is allowed while reporting a result.";
  }
  return null;
}

/** The cumulative autonomous-continuation limit, or null while there is room. */
export function codeAutoChainRefusal({ autoChain, maxChain }) {
  return autoChain > maxChain
    ? `Autonomous Code continuations reached the cumulative limit of ${maxChain}. Report the remaining work and let the user decide.`
    : null;
}

/** The prompt rule: a non-empty trimmed prompt within the limit, except for an abort. */
export function codePromptRefusal({ action, prompt }) {
  if (action === "abort") return null;
  if (!prompt?.trim() || prompt.length > MAX_CODE_PROMPT_CHARS) {
    return "A prompt of 1–32000 characters is required";
  }
  return null;
}

/**
 * The state of the Code session a follow-up prompt targets. The caller supplies the facts; the order
 * matters because the message is the same for every unusable case, while "available" is the only
 * state that lets a follow-up proceed.
 */
export function codeLinkedSessionState({ hasSession, archived, permissionDenied, busy }) {
  if (hasSession !== true) return "missing";
  if (archived === true) return "archived";
  if (permissionDenied === true) return "denied";
  if (busy === true) return "busy";
  return "available";
}

/**
 * The pre-launch refusals, in order: a Bot that does not allow Code delegation, a Room request whose
 * turn is gone, an action that is neither start nor prompt, and a follow-up whose target session is
 * unusable (the caller passes the state from `codeLinkedSessionState`).
 */
export function codeLaunchRefusal({ botPermissionMode, isRoomRequest, roomRequestCurrent, action, linkedState }) {
  if (botPermissionMode === "deny") return "This Bot does not permit Code delegation";
  if (isRoomRequest === true && roomRequestCurrent !== true) return "Room request is no longer active";
  if (action !== "start" && action !== "prompt") return "Unknown Code action";
  if (action === "prompt" && linkedState !== "available") {
    return "The linked Code session is unavailable or busy; start a separate Code request for independent work";
  }
  return null;
}

/** A start or follow-up may only use a registered, active project. */
export function codeProjectRefusal({ hasProjectId, hasProject, archived }) {
  if (hasProjectId !== true) return null;
  return hasProject === true && archived !== true ? null : "Project is unavailable";
}

/**
 * The outbox row for a new Code request. A `prompt` action targets the linked session and records the
 * message it must read from (`baseline`); a `start` creates its own session, so both the id and the
 * baseline are null. Optional parts are omitted rather than stored empty: a request without a Goal
 * Loop, without an autonomous-continuation count, without a Room origin and without images keeps
 * those keys out of the file, which is what the readers expect.
 */
export function buildCodeRequestRecord({
  id,
  botId,
  originTaskId,
  action,
  linkedTaskId,
  projectId,
  goalLoop,
  autoChain,
  queuedAt,
  prompt,
  baseline,
  room,
  images,
}) {
  const isPrompt = action === "prompt";
  return {
    id,
    botId,
    originTaskId,
    codeTaskId: isPrompt ? linkedTaskId ?? null : null,
    state: "starting",
    action: isPrompt ? "prompt" : "start",
    projectId,
    ...(goalLoop ? { goalLoop } : {}),
    ...(autoChain ? { autoChain } : {}),
    queuedAt,
    prompt: typeof prompt === "string" ? prompt.trim() : "",
    baseline: isPrompt ? baseline ?? null : null,
    ...(room ? { room } : {}),
    ...(images?.length ? { promptOptions: { images } } : {}),
  };
}

/**
 * The summary of one request: the fields the Bot panel reads, plus the delivered outcome and Goal
 * Loop report. Nothing else from the file is exposed, so internal bookkeeping (supervision,
 * auto-chain counts, image options) never reaches the UI.
 */
export function codeRequestSummary(request) {
  return {
    id: request.id,
    codeTaskId: request.codeTaskId,
    state: request.state,
    prompt: request.prompt,
    result: request.result,
    queuedAt: request.queuedAt,
    ...codeRequestPayload(request),
  };
}

/**
 * The requests a Bot panel lists: its own requests, excluding user interventions (those belong to the
 * Code UI), newest first. A request without a queue time sorts last rather than crashing the compare.
 */
export function codeRequestSummaries(requests, botId) {
  return requests
    .filter((request) => request.botId === botId && !request.userIntervention)
    .map(codeRequestSummary)
    .sort((a, b) => (b.queuedAt ?? 0) - (a.queuedAt ?? 0));
}

/**
 * The report a Bot turn produced for one Code request, read from the transcript.
 *
 * The window starts at the hidden custom message that carries the request id and ends at the next
 * Code-result custom message (a later request) or the next user message (a new instruction), whichever
 * comes first — anything after that belongs to another turn. Inside the window only an assistant
 * message that stopped normally counts, and only when its text is non-empty after trimming, so a
 * cancelled or tool-only turn does not look like a report. Returns undefined when there is none.
 */
export function botCodeReportText(entries, requestId, codeResultType) {
  let found = false;
  for (const value of entries) {
    const entry = value;
    if (entry?.type === "custom_message") {
      if (entry.customType === codeResultType && entry.details?.requestId === requestId) found = true;
      else if (found && entry.customType === codeResultType) found = false;
    }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (found && message?.role === "user") {
      found = false;
      continue;
    }
    if (found && message?.role === "assistant" && message.stopReason === "stop") {
      const text = message.content
        ?.filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join(String.fromCharCode(10));
      if (text?.trim()) return text;
    }
  }
  return undefined;
}

/**
 * The requests that belong to one Room conversation turn. A turn is identified by the Room and the
 * conversation's request id, so a later user turn never sees the previous turn's jobs. `activeOnly`
 * keeps only the requests that still hold a claim (used to decide what is still pending); a caller
 * that needs the settled ones as well leaves it off. An `excludeRequestId` skips one record, which is
 * how a caller asks "what else is pending for this turn".
 */
export function codeRequestsForRoomTurn(requests, { roomId, requestId, excludeRequestId, activeOnly }) {
  return requests.filter((request) =>
    request.id !== excludeRequestId &&
    request.room?.id === roomId &&
    request.room.conversation?.requestId === requestId &&
    (activeOnly !== true || isActiveCodeRequest(request)),
  );
}

/**
 * The distinct Code sessions a teardown must stop, in the order the requests were read. Settled
 * requests are included on purpose: a request can be delivered in the outbox while its Code session
 * still runs (a cold-gap orphan), so filtering by state here would leave that session alive.
 */
export function codeStopTargets(requests, matches) {
  const targets = [];
  for (const request of requests) {
    if (!matches(request)) continue;
    const taskId = request.codeTaskId;
    if (typeof taskId !== "string" || taskId === "" || targets.includes(taskId)) continue;
    targets.push(taskId);
  }
  return targets;
}

/**
 * Whether a Code session still needs stopping. A missing or archived task has nothing to stop, and a
 * task that is neither working nor owned by a Goal Loop is already finished — the Goal Loop case
 * matters because such a session keeps its own turn alive.
 */
export function shouldStopCodeSession({ hasTask, archived, working, goalLoopOwned }) {
  if (hasTask !== true || archived === true) return false;
  return working === true || goalLoopOwned === true;
}

/**
 * The reverse of `runningCodeTaskIdsForOrigin`: the launch request that is still running one Code
 * task. Only a launch request in `starting`/`running` counts (a delivered or cancelled one no longer
 * owns the session), a user intervention is skipped, and the first match in read order wins so every
 * reader resolves the same request.
 */
export function codeRequestForCodeTask(requests, codeTaskId) {
  return requests.find(
    (request) =>
      request.codeTaskId === codeTaskId &&
      !request.userIntervention &&
      (request.state === "starting" || request.state === "running"),
  );
}
