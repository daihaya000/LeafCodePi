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

export function oneToOneBotIdFromTaskId(taskId: string): string | null;

export function resolveAttachAccount(input: {
  /** undefined = use the task account; null = explicitly no account. */
  sessionAccountId?: string | null;
  taskAccountId?: string | null;
  existingAccountId?: string | null;
}): { accountId: string | null; acquire: boolean };
