export function findStaleRoomTurns<
  M extends { status?: string; createdAt: number; botId?: string | null },
>(
  messages: readonly M[],
  options: {
    now: number;
    staleMs: number;
    taskIdFor: (botId: string) => string;
    isRunOwned: (taskId: string) => boolean;
    hasActiveLease: (taskId: string) => boolean;
    getTask: (taskId: string) => { status?: string; updatedAt: string } | undefined | null;
  },
): M[];

export function runRoomReconcile(deps: {
  listRooms: () => Array<{ id: string }>;
  settleStaleTurns: (roomId: string) => unknown;
  settleHandoffs: (roomId: string) => number;
  deliverHandoffs: (roomId: string) => Promise<unknown> | unknown;
  warn: (message: string, reason: string) => void;
}): void;
