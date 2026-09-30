import type { PermissionRequestDto, QuestionRequestDto } from "@shared/types";

export const PENDING_PROMPT_TIMEOUT_MS: number;
export type QuestionAnswer = { answers: string[][] };
export type TimerHandle = unknown;

export type PermissionPromptEmit = (
  taskId: string,
  payload: { type: string; permissionRequest?: PermissionRequestDto | null; [key: string]: unknown },
) => void;
export type QuestionPromptEmit = (
  taskId: string,
  payload: { type: string; questionRequest?: QuestionRequestDto | null; [key: string]: unknown },
) => void;

type CommonOptions = {
  resolveTaskId: (sessionId: string) => string | null;
  snapshotExtras: (taskId: string) => Record<string, unknown>;
  timeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

type ServiceShape<Request, Value> = {
  pendingForTask: (taskId: string) => Request | null;
  pendingTaskIds: () => Set<string>;
  clearPendingForTask: (taskId: string) => boolean;
  dispose: () => void;
  respond: (taskId: string, requestId: string, value: Value) => boolean;
};

export function taskIdForSession(
  sessionId: string,
  liveEntries: Iterable<{ taskId: string; sessionId: string | undefined }>,
): string | null;

export function createPermissionPromptService(
  options: CommonOptions & { emit: PermissionPromptEmit },
): ServiceShape<PermissionRequestDto, boolean> & {
  /** Resolves null when the session cannot be mapped to a task (no dialog). */
  handleRequest: (input: PermissionRequestDto) => Promise<boolean | null>;
};

export function createQuestionPromptService(
  options: CommonOptions & { emit: QuestionPromptEmit },
): ServiceShape<QuestionRequestDto, QuestionAnswer | null> & {
  handleRequest: (input: QuestionRequestDto) => Promise<QuestionAnswer | null>;
};
