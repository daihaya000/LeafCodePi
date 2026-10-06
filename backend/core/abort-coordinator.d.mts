export const TASK_NOT_FOUND_MESSAGE: string;

type MessageLike = { role?: string; id?: string };

export type UserAbortDeps<Live, Message extends MessageLike, Task, Summary> = {
  disarmHangWatch: (taskId: string) => void;
  clearPendingAttention: (taskId: string) => void;
  getLive: (taskId: string) => Live | undefined;
  clearSessionQueue: (live: Live) => void;
  cancelPrompt: (live: Live) => void;
  cancelPendingSnapshot: (live: Live) => void;
  persistManualAbortedAssistantId: (taskId: string, assistantId: string) => void;
  /** Starts the native abort; the returned promise is awaited last. */
  abortSession: (live: Live) => Promise<unknown>;
  /** Clears one-shot self-resume reservations, including an idle session. */
  cancelScheduledResume?: (live: Live) => Promise<unknown>;
  snapshotMessages: (live: Live) => Message[];
  stopGoalLoop: (live: Live) => Promise<unknown>;
  stopSubagentRuns: (live: Live, messages: Message[]) => Promise<unknown>;
  setIdle: (taskId: string) => Task | undefined;
  releaseLease: (taskId: string) => void;
  emitAbort: (live: Live) => void;
  flushRoomMailbox: (botId: string) => void;
  warn: (message: string, error: unknown) => void;
  toSummary: (task: Task) => Summary;
};

export function runUserAbort<Live, Message extends MessageLike, Task, Summary>(
  taskId: string,
  deps: UserAbortDeps<Live, Message, Task, Summary>,
): Promise<Summary>;

export type HangWatchdogAbortDeps<Live, Message extends MessageLike> = {
  getHangWatchStartedAt: (taskId: string) => number | undefined;
  getHangWatch: (taskId: string) => { startedAt: number } | null | undefined;
  getLive: (taskId: string) => Live | undefined;
  clearPendingAttention: (taskId: string) => void;
  clearSessionQueue: (live: Live) => void;
  cancelPrompt: (live: Live) => void;
  cancelPendingSnapshot: (live: Live) => void;
  persistManualAbortedAssistantId: (taskId: string, assistantId: string) => void;
  abortSession: (live: Live) => Promise<unknown>;
  snapshotMessages: (live: Live) => Message[];
  emitHangAbort: (live: Live) => void;
  stopSubagentRuns: (live: Live, messages: Message[]) => Promise<unknown>;
  setIdle: (taskId: string) => unknown;
  releaseLease: (taskId: string) => void;
  emitHangIdle: (live: Live) => void;
  flushRoomMailbox: (botId: string) => void;
  warn: (message: string, error: unknown) => void;
};

export function runHangWatchdogAbort<Live, Message extends MessageLike>(
  taskId: string,
  deps: HangWatchdogAbortDeps<Live, Message>,
): Promise<void>;
