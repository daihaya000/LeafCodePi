import type { QuestionRequestDto } from "@/lib/types";

export type QuestionPromptEmit = (
  taskId: string,
  payload: { type: string; questionRequest?: QuestionRequestDto | null; [key: string]: unknown },
) => void;

export type QuestionAnswer = { answers: string[][] };

type Pending = {
  taskId: string;
  request: QuestionRequestDto;
  resolve: (answer: QuestionAnswer | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const QUESTION_TIMEOUT_MS = 5 * 60_000;

const pendingById = new Map<string, Pending>();
const queueByTask = new Map<string, Pending[]>();

function clearPendingRow(row: Pending): void {
  clearTimeout(row.timer);
  pendingById.delete(row.request.id);
}

function headPending(taskId: string): Pending | null {
  return queueByTask.get(taskId)?.[0] ?? null;
}

function finishHead(taskId: string, answer: QuestionAnswer | null): Pending | null {
  const queue = queueByTask.get(taskId);
  if (!queue || queue.length === 0) return null;
  const row = queue.shift()!;
  clearTimeout(row.timer);
  pendingById.delete(row.request.id);
  row.resolve(answer);
  if (queue.length === 0) {
    queueByTask.delete(taskId);
    return null;
  }
  const next = queue[0]!;
  armTimer(next);
  return next;
}

function armTimer(row: Pending): void {
  clearTimeout(row.timer);
  row.timer = setTimeout(() => {
    if (headPending(row.taskId)?.request.id !== row.request.id) return;
    // タイムアウトは拒否扱い（null）。モデルには自分で判断するよう指示する。
    finishHead(row.taskId, null);
    pushSnapshotGlobal(row.taskId, headPending(row.taskId)?.request ?? null);
  }, QUESTION_TIMEOUT_MS);
}

/** Set by createQuestionPromptService — used by armTimer for timeouts. */
let pushSnapshotGlobal: (taskId: string, questionRequest: QuestionRequestDto | null) => void =
  () => undefined;

export function createQuestionPromptService(options: {
  resolveTaskId: (sessionId: string) => string | null;
  emit: QuestionPromptEmit;
  snapshotExtras: (taskId: string) => Record<string, unknown>;
}): {
  handleRequest: (
    input: Omit<QuestionRequestDto, "id"> & { id: string },
  ) => Promise<QuestionAnswer | null>;
  respond: (taskId: string, requestId: string, answer: QuestionAnswer | null) => boolean;
  pendingForTask: (taskId: string) => QuestionRequestDto | null;
  pendingTaskIds: () => Set<string>;
  dispose: () => void;
} {
  function pushSnapshot(taskId: string, questionRequest: QuestionRequestDto | null): void {
    options.emit(taskId, {
      type: "snapshot",
      eventType: questionRequest ? "question_request" : "question_resolved",
      questionRequest,
      ...options.snapshotExtras(taskId),
    });
  }
  pushSnapshotGlobal = pushSnapshot;

  function handleRequest(
    input: Omit<QuestionRequestDto, "id"> & { id: string },
  ): Promise<QuestionAnswer | null> {
    const taskId = options.resolveTaskId(input.sessionId);
    if (!taskId) return Promise.resolve(null);

    const request: QuestionRequestDto = {
      id: input.id,
      sessionId: input.sessionId,
      questions: input.questions,
    };

    return new Promise((resolve) => {
      const row: Pending = {
        taskId,
        request,
        resolve,
        timer: setTimeout(() => undefined),
      };
      armTimer(row);

      pendingById.set(request.id, row);
      const queue = queueByTask.get(taskId) ?? [];
      queue.push(row);
      queueByTask.set(taskId, queue);

      if (queue.length === 1) pushSnapshot(taskId, request);
    });
  }

  function respond(taskId: string, requestId: string, answer: QuestionAnswer | null): boolean {
    const head = headPending(taskId);
    if (!head || head.request.id !== requestId) return false;
    const next = finishHead(taskId, answer);
    pushSnapshot(taskId, next?.request ?? null);
    return true;
  }

  function pendingForTask(taskId: string): QuestionRequestDto | null {
    return headPending(taskId)?.request ?? null;
  }

  function pendingTaskIds(): Set<string> {
    return new Set(queueByTask.keys());
  }

  function dispose(): void {
    for (const taskId of [...queueByTask.keys()]) {
      const queue = queueByTask.get(taskId) ?? [];
      for (const row of queue) {
        row.resolve(null);
        clearPendingRow(row);
      }
      queueByTask.delete(taskId);
    }
  }

  return { handleRequest, respond, pendingForTask, pendingTaskIds, dispose };
}
