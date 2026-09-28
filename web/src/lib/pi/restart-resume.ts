import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { ORPHANED_WORKING_TASK_ERROR } from "@/lib/task-runtime-lease";
import type { TaskSummary } from "@/lib/types";

/**
 * WebUI再起動で中断された Code セッションの自動再開。
 *
 * reconcileOrphanedWorkingTasks が working→error にしたタスクを受け取り、
 * 起動が落ち着いてから一度だけ続行プロンプトを送る。再起動ループで同じ
 * タスクを無限に再送しないよう、試行回数をデータディレクトリへ永続化する。
 */

export const RESTART_RESUME_PROMPT =
  "WebUIの再起動で前のターンが中断されました。完了済みの操作は繰り返さず、中断した箇所から作業を続けてください。";
/** ランタイム初期化・Bot relay・ルーティン起動を先に済ませる。 */
export const RESTART_RESUME_DELAY_MS = 5_000;
/** 複数セッションの同時起動でプロバイダー・ディスクを詰まらせない。 */
export const RESTART_RESUME_STAGGER_MS = 1_000;
/** 同じタスクを窓内で自動再開する上限（再起動ループ対策）。 */
export const RESTART_RESUME_MAX_ATTEMPTS = 2;
export const RESTART_RESUME_WINDOW_MS = 30 * 60_000;
/** 長時間停止していたホストの古い working 残骸は再開しない。 */
export const RESTART_RESUME_MAX_STALE_MS = 12 * 60 * 60_000;

export type RestartResumeDeps = {
  getTask: (id: string) => TaskSummary | undefined;
  promptTask: (id: string, prompt: string) => Promise<unknown>;
  isGoalLoopOwned: (task: TaskSummary) => boolean;
  isRoomDelegated: (taskId: string) => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
  log?: (message: string, error?: unknown) => void;
};

type AttemptRecord = { count: number; lastAt: number };

function attemptsPath(): string {
  return join(dataDir(), "restart-resume.json");
}

function readAttempts(): Record<string, AttemptRecord> {
  try {
    const parsed = JSON.parse(readFileSync(attemptsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, AttemptRecord> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, Partial<AttemptRecord>>)) {
      if (typeof value?.count === "number" && typeof value.lastAt === "number") {
        result[id] = { count: value.count, lastAt: value.lastAt };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAttempts(records: Record<string, AttemptRecord>): void {
  const path = attemptsPath();
  mkdirSync(dataDir(), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records)}\n`, "utf8");
  renameSync(temporary, path);
}

/** 試行を記録して再開してよいか返す。窓を過ぎた記録は数え直す。 */
function claimAttempt(taskId: string, now: number): boolean {
  const records = readAttempts();
  for (const [id, record] of Object.entries(records)) {
    if (now - record.lastAt > RESTART_RESUME_WINDOW_MS) delete records[id];
  }
  const count = records[taskId]?.count ?? 0;
  if (count >= RESTART_RESUME_MAX_ATTEMPTS) {
    writeAttempts(records);
    return false;
  }
  records[taskId] = { count: count + 1, lastAt: now };
  writeAttempts(records);
  return true;
}

/** 中断直前（working）のスナップショットで判定できる除外理由。null なら再開候補。 */
export function restartResumeSkipReason(snapshot: TaskSummary, now: number): string | null {
  if ((snapshot.kind ?? "code") !== "code") return "not a Code task";
  // Bot管轄・監督下の Code は relay が失敗を報告済み。二重実行を避ける。
  if (snapshot.botId || snapshot.supervisorBotId) return "Bot-managed task";
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (Number.isFinite(updatedAt) && now - updatedAt > RESTART_RESUME_MAX_STALE_MS) {
    return "interrupted too long ago";
  }
  return null;
}

function defaultLog(message: string, error?: unknown): void {
  if (error === undefined) console.info(`[restart-resume] ${message}`);
  else console.warn(`[restart-resume] ${message}`, error);
}

/** 再開を実行した場合 true。 */
export async function resumeOrphanedTask(
  snapshot: TaskSummary,
  deps: RestartResumeDeps,
): Promise<boolean> {
  const log = deps.log ?? defaultLog;
  const now = (deps.now ?? Date.now)();
  const task = deps.getTask(snapshot.id);
  // 待機中にユーザーが再送・停止・削除したら触らない。
  if (!task || task.status !== "error" || task.error !== ORPHANED_WORKING_TASK_ERROR) return false;
  if (deps.isRoomDelegated(task.id)) {
    log(`skip ${task.id}: Room-delegated task`);
    return false;
  }
  if (deps.isGoalLoopOwned(task)) {
    log(`skip ${task.id}: Goal Loop owns the session`);
    return false;
  }
  try {
    if (!claimAttempt(task.id, now)) {
      log(`skip ${task.id}: reached ${RESTART_RESUME_MAX_ATTEMPTS} restart resumes within the window`);
      return false;
    }
  } catch (error) {
    // 回数を記録できない状態で再送すると再起動ループを止められない。
    log(`skip ${task.id}: could not record the resume attempt`, error);
    return false;
  }
  try {
    await deps.promptTask(task.id, RESTART_RESUME_PROMPT);
    log(`resumed ${task.id} after restart`);
    return true;
  } catch (error) {
    log(`resume failed for ${task.id}`, error);
    return false;
  }
}

/** reconcileOrphanedWorkingTasks の listener。候補を遅延実行で再開する。 */
export function handleOrphanedTasks(snapshots: TaskSummary[], deps: RestartResumeDeps): string[] {
  const log = deps.log ?? defaultLog;
  const now = (deps.now ?? Date.now)();
  const schedule = deps.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
  });
  const scheduled: string[] = [];
  for (const snapshot of snapshots) {
    const reason = restartResumeSkipReason(snapshot, now);
    if (reason) {
      log(`skip ${snapshot.id}: ${reason}`);
      continue;
    }
    const delayMs = RESTART_RESUME_DELAY_MS + scheduled.length * RESTART_RESUME_STAGGER_MS;
    scheduled.push(snapshot.id);
    schedule(() => { void resumeOrphanedTask(snapshot, deps); }, delayMs);
  }
  return scheduled;
}
