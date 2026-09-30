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
