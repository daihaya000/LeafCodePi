import type { PermissionRequestDto, QuestionRequestDto } from "@shared/types";

export const PENDING_PROMPT_TIMEOUT_MS: number;
export class PendingPromptIdCollisionError extends Error {
  readonly code: "PENDING_PROMPT_ID_COLLISION";
}
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
  /** Receives the notice when a request id collides with a pending one from another session. */
  warn?: (message: string) => void;
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
  /** Resolves null when unmapped; rejects with PendingPromptIdCollisionError for a pending id collision. */
  handleRequest: (input: PermissionRequestDto) => Promise<boolean | null>;
};

export function createQuestionPromptService(
  options: CommonOptions & { emit: QuestionPromptEmit },
): ServiceShape<QuestionRequestDto, QuestionAnswer | null> & {
  /** Rejects with PendingPromptIdCollisionError for a pending id collision. */
  handleRequest: (input: QuestionRequestDto) => Promise<QuestionAnswer | null>;
};
