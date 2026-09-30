export const TASK_NOT_FOUND_MESSAGE: string;

export type UserAbortDeps<Live, Message extends { role?: string; id?: string }, Task, Summary> = {
  disarmHangWatch: (taskId: string) => void;
  clearPendingAttention: (taskId: string) => void;
  getLive: (taskId: string) => Live | undefined;
  clearSessionQueue: (live: Live) => void;
  cancelPrompt: (live: Live) => void;
  cancelPendingSnapshot: (live: Live) => void;
  persistManualAbortedAssistantId: (taskId: string, assistantId: string) => void;
  /** Starts the native abort; the returned promise is awaited last. */
  abortSession: (live: Live) => Promise<unknown>;
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

export function runUserAbort<Live, Message extends { role?: string; id?: string }, Task, Summary>(
  taskId: string,
  deps: UserAbortDeps<Live, Message, Task, Summary>,
): Promise<Summary>;
