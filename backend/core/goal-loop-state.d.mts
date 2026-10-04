import type { GoalLoopDto } from "@shared/types";

export const GOAL_LOOP_DIR: string;
/** Same file-name derivation as the leafcode-goal-loop extension. */
export function safeIdPart(value: string): string;

export class GoalLoopStateStore {
  constructor(options: {
    dataDir: () => string;
    clampMaxTurns: (value: unknown) => number;
    clampCooldownSeconds: (value: unknown) => number;
    maxCacheEntries?: number;
  });
  /** cwd is accepted for caller compatibility; state placement is global. */
  stateFile(cwd: string, sessionId: string): string;
  /** The pre-digest file name older builds used for ids that needed sanitizing. */
  legacyStateFile(cwd: string, sessionId: string): string;
  read(cwd: string, sessionId: string | null | undefined): GoalLoopDto | null;
  invalidate(file: string): void;
  static isOperatorHold(loop: { status?: string | null; pauseReason?: string | null } | null | undefined): boolean;
}
