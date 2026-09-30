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
 * Reuse/join decision before creating a session: { action: "reuse", live } or "proceed".
 */
export function resolveEnsureLiveAttempt(steps: {
  existing?: unknown;
  touchExisting: () => void;
  inflight?: Promise<unknown> | undefined;
  /** Runs after the join: re-checks the task, then returns the registered live. */
  afterJoin: () => unknown;
  isStale: () => boolean;
}): Promise<{ action: "reuse"; live: unknown } | { action: "proceed" }>;

/**
 * The ensure-live gates: attachable check, promotion wait, repeat check, retirement wait.
 */
export function runEnsureLiveGates(steps: {
  isAttachable: () => boolean;
  allowDuringPromotion: boolean;
  promotion?: Promise<unknown> | undefined;
  retirement?: Promise<unknown> | undefined;
}): Promise<"continue" | "not-attachable">;

/**
 * Publishes a freshly attached live in a fixed order: stop hook, activity stamp,
 * registry insert, then the 1:1 Bot mailbox promotion.
 */
export function publishAttachedLive(steps: {
  setUnsubscribe: () => void;
  markActivity: () => void;
  register: () => void;
  promoteMailbox: () => void;
}): void;

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
 * Discards a session that was created but never attached, swallowing disposal
 * errors and deliberately not emitting extension shutdown.
 */
export function disposeUnattachedSession<S>(
  session: S,
  disposeSession?: (session: S) => void,
): void;

/**
 * After creating a session: a stale generation wins over a vanished task, and only
 * otherwise may it be attached.
 */
export function resolveCreatedSessionAction(input: {
  staleGeneration: boolean;
  hasTask: boolean;
}): "retry" | "not-found" | "attach";

/**
 * After attaching: a stale generation disposes the attached live when it is still
 * the registered one, and always retries.
 */
export function resolveAttachedSessionAction(input: {
  staleGeneration: boolean;
  isRegistered: boolean;
}): "keep" | "dispose-and-retry" | "retry";

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

/** Whether a live setting must be deferred instead of applied to the session now. */
export function shouldDeferLiveSetting(input: {
  busyForReplace: boolean;
  taskStatus: string | undefined;
  activeGoalLoopSession: boolean;
  goalLoopOwned: boolean;
}): boolean;

/** Whether a pending reload may run now (streaming/compacting block it; promptActive does not). */
export function shouldApplyPendingReload(input: {
  pending: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
}): boolean;

/** Whether a Bot session's SOUL must be reloaded after a revision change. */
export function shouldFlagSoulReload(input: { isBot: boolean; hasBotId: boolean; revisionChanged: boolean }): boolean;

/** Whether the agent-definition reload is needed for this live session. */
export function shouldReloadAgentDefinition(input: { pending: boolean; missingRegistration: boolean }): boolean;

/** Whether the requested route equals the session's route (no replace needed). */
export function isSamePromptRoute(input: {
  currentAccountId: string | null | undefined;
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  requestedAccountId: string | null | undefined;
  requestedProviderId: string | undefined;
  requestedModelId: string | undefined;
}): boolean;

/** Settings a busy session may apply without being replaced, in application order. */
export const SOFT_LIVE_SETTING_KEYS: readonly string[];

/** The subset of a pending settings record a busy session may apply now. */
export function softLiveSettings(requested: Record<string, unknown> | undefined): Record<string, unknown>;
