export function hasOtherBusyRoomLive(
  departingTaskId: string,
  roomBotId: string,
  liveEntries: Iterable<
    readonly [string, { promptActive?: boolean; session: { isStreaming?: boolean; isCompacting?: boolean } }]
  >,
): boolean;

export function shouldShutdownOnDispose(input: {
  shutdownEmitted: boolean | undefined;
  hasShutdownHandler: () => boolean;
  isBusyOrGoalLoopActive: () => boolean;
  isGoalLoopOwned: () => boolean;
}): boolean;

export function detachReplacedLive<Live extends {
  unsubscribe: () => void;
  accountId?: string | null;
  session: unknown;
  snapshotTimer?: unknown;
}>(
  existing: Live | undefined,
  session: unknown,
  attachedAccountId: string | null,
  deps: {
    releaseAccount: (accountId: string) => void;
    disposeSession: (session: unknown) => void;
    clearSnapshotTimer: (timer: unknown) => void;
  },
): void;

export function oneToOneBotIdFromTaskId(taskId: string): string | null;

/** 1:1 Bot attaches promote queued mailbox rows; Room attaches never do. */
export function promoteMailboxOnAttach(
  taskId: string,
  deps: {
    flushMailbox: (botId: string) => void;
    warn: (message: string, error: unknown) => void;
  },
): boolean;

export function resolveAttachAccount(input: {
  /** undefined = use the task account; null = explicitly no account. */
  sessionAccountId?: string | null;
  taskAccountId?: string | null;
  existingAccountId?: string | null;
}): { accountId: string | null; acquire: boolean };
