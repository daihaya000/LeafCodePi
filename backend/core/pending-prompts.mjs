export const PENDING_PROMPT_TIMEOUT_MS = 5 * 60_000;

export function taskIdForSession(sessionId, liveEntries) {
  for (const entry of liveEntries) {
    if (entry.sessionId === sessionId) return entry.taskId;
  }
  return null;
}

/**
 * Per-task FIFO of pending user decisions. State belongs to the service
 * instance, and timers/emit/session lookup are injected; importing this module
 * does no work. Only the head request is visible and only the head times out.
 */
function createPendingPromptService(options, kind) {
  const {
    resolveTaskId, emit, snapshotExtras,
    timeoutMs = PENDING_PROMPT_TIMEOUT_MS,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  } = options;
  const pendingById = new Map();
  const queueByTask = new Map();

  function clearPendingRow(row) {
    if (row.timer !== null) clearTimer(row.timer);
    row.timer = null;
    pendingById.delete(row.request.id);
  }

  function headPending(taskId) { return queueByTask.get(taskId)?.[0] ?? null; }

  function pushSnapshot(taskId, request) {
    emit(taskId, {
      type: "snapshot",
      eventType: request ? kind.requestEvent : kind.resolvedEvent,
      [kind.field]: request,
      ...snapshotExtras(taskId),
    });
  }

  function armTimer(row) {
    if (row.timer !== null) clearTimer(row.timer);
    row.timer = setTimer(() => {
      if (headPending(row.taskId)?.request.id !== row.request.id) return;
      finishHead(row.taskId, kind.timeoutValue);
      pushSnapshot(row.taskId, headPending(row.taskId)?.request ?? null);
    }, timeoutMs);
  }

  function finishHead(taskId, value) {
    const queue = queueByTask.get(taskId);
    if (!queue || queue.length === 0) return null;
    const row = queue.shift();
    clearPendingRow(row);
    row.resolve(value);
    if (queue.length === 0) {
      queueByTask.delete(taskId);
      return null;
    }
    const next = queue[0];
    armTimer(next);
    return next;
  }

  function handleRequest(input) {
    const taskId = resolveTaskId(input.sessionId);
    // An unmapped session is not a user decision.
    if (!taskId) return Promise.resolve(null);
    const request = kind.buildRequest(input);
    return new Promise((resolve) => {
      const row = { taskId, request, resolve, timer: null };
      armTimer(row);
      pendingById.set(request.id, row);
      const queue = queueByTask.get(taskId) ?? [];
      queue.push(row);
      queueByTask.set(taskId, queue);
      if (queue.length === 1) pushSnapshot(taskId, request);
    });
  }

  function respond(taskId, requestId, value) {
    const head = headPending(taskId);
    if (!head || head.request.id !== requestId) return false;
    const next = finishHead(taskId, value);
    pushSnapshot(taskId, next?.request ?? null);
    return true;
  }

  function pendingForTask(taskId) { return headPending(taskId)?.request ?? null; }
  function pendingTaskIds() { return new Set(queueByTask.keys()); }

  function clearPendingForTask(taskId) {
    const queue = queueByTask.get(taskId);
    if (!queue || queue.length === 0) return false;
    for (const row of queue) {
      row.resolve(kind.timeoutValue);
      clearPendingRow(row);
    }
    queueByTask.delete(taskId);
    pushSnapshot(taskId, null);
    return true;
  }

  function dispose() {
    for (const taskId of [...queueByTask.keys()]) {
      for (const row of queueByTask.get(taskId) ?? []) {
        row.resolve(kind.timeoutValue);
        clearPendingRow(row);
      }
      queueByTask.delete(taskId);
    }
  }

  return { handleRequest, respond, pendingForTask, pendingTaskIds, clearPendingForTask, dispose };
}

export function createPermissionPromptService(options) {
  return createPendingPromptService(options, {
    field: "permissionRequest",
    requestEvent: "permission_request",
    resolvedEvent: "permission_resolved",
    // Timeout, abort and disposal are refusals, not approvals.
    timeoutValue: false,
    buildRequest: (input) => ({
      id: input.id, sessionId: input.sessionId, command: input.command,
      labels: input.labels, message: input.message,
    }),
  });
}

export function createQuestionPromptService(options) {
  return createPendingPromptService(options, {
    field: "questionRequest",
    requestEvent: "question_request",
    resolvedEvent: "question_resolved",
    timeoutValue: null,
    buildRequest: (input) => ({ id: input.id, sessionId: input.sessionId, questions: input.questions }),
  });
}
