type StartupStep = () => unknown | Promise<unknown>;

export type RuntimeStartupServices = {
  registerRestartResume: StartupStep;
  reconcileOrphanedWorkingTasks: StartupStep;
  startBotCodeRelay: StartupStep;
  ensureRoutineScheduler: StartupStep;
  reconcileRoomRuntime: StartupStep;
  warmTaskSummaries?: StartupStep;
  warmModels?: StartupStep;
  backfillMissingTaskLabels?: StartupStep;
};

export const SESSION_LABEL_BACKFILL_DELAY_MS: number;

export class RuntimeStartup {
  constructor(options: {
    loadServices: () => RuntimeStartupServices | Promise<RuntimeStartupServices>;
    warn?: (message: string, error: unknown) => void;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  });
  start(): Promise<void>;
  cancelWarmups(): void;
}
