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

/**
 * Runs the deferred shutdown for a task and records it as in flight, so a second
 * dispose for the same task joins the first instead of disposing twice.
 */
export function runCoalescedLiveShutdown(
  taskId: string,
  deps: {
    inflight: Map<string, Promise<void>>;
    runShutdown: () => Promise<void>;
    /** Runs after the extension shutdown settles, success or failure. */
    disposeSession: () => void;
  },
): Promise<void>;

/** True when an ensure-live attempt started in an epoch that is no longer current. */
export function isStaleEnsureEpoch(currentEpoch: number | undefined | null, epoch: number): boolean;

/** True when the live registered for the task is exactly the one this attempt attached. */
export function isRegisteredLive<Live>(getLive: () => Live | undefined, attached: Live): boolean;

/**
 * Records an ensure-live attempt as in flight for the task and clears it on settle,
 * unless a newer attempt replaced the entry. The result is passed through.
 */
export function runTrackedEnsure<T>(
  taskId: string,
  deps: {
    inflight: Map<string, Promise<T>>;
    attempt: () => Promise<T>;
  },
): Promise<T>;

/**
 * After joining an in-flight ensure-live: a stale generation forces a retry even
 * when a live is registered; otherwise the registered live is adopted, and with
 * none the caller retries.
 */
export function resolveJoinedEnsureAction(input: { stale: boolean; hasLive: boolean }): "use-live" | "retry";

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
