"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/client";
import { activeToolLabel, changedFilePaths } from "@/lib/tool-labels";
import type { CodeRequestGoalLoopReport, CodeRequestState, TaskDetail } from "@/lib/types";
import { BotMessageMarkdown } from "@/components/bot/BotMessageList";

const CODE_STATE_TEXT: Record<CodeRequestState, string> = {
  queued: "Code待機中",
  starting: "Code起動準備",
  running: "Code実行中",
  ready: "Code結果を報告中",
  delivered: "Code結果受領",
  cancelled: "Code中断",
};

const LIVE_GOAL_LOOP_STATUSES = new Set(["queued", "running", "verifying_completed"]);
/** Outcomes that finished as asked. Anything else (stop, block, turn limit) must not read as success. */
const SUCCESS_OUTCOMES = new Set(["実行終了", "目標達成"]);

const TASK_STATUS_TEXT: Record<TaskDetail["status"], string> = {
  working: "実行中",
  ready: "待機中",
  idle: "待機中",
  error: "エラー",
  archived: "アーカイブ済み",
  unknown: "不明",
};

function latestCodeOutput(task: TaskDetail): string {
  for (const message of [...(task.messages ?? [])].reverse()) {
    if (message.role !== "assistant") continue;
    const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}

export function CodeRequestCard({
  taskId,
  prompt,
  state,
  outcome,
  goalLoop,
  activity,
  stopping,
  onStop,
}: {
  taskId?: string | null;
  prompt?: string;
  state: CodeRequestState;
  /** Real result of the delegated run (実行終了 / ユーザーが停止 / 失敗 ...). Delivery alone is not success. */
  outcome?: string;
  /** Loop verdict of a finished run, so the promise and the blocker are readable without opening Code. */
  goalLoop?: CodeRequestGoalLoopReport;
  activity?: string;
  stopping?: boolean;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = state === "queued" || state === "starting" || state === "running";

  useEffect(() => {
    if (!taskId) return;
    let closed = false;
    const load = async () => {
      setLoading(true);
      try {
        const result = await getJson<{ task: TaskDetail | null }>(`/api/tasks/${encodeURIComponent(taskId)}`);
        if (closed) return;
        setTask(result.task ?? null);
        setError(null);
      } catch (reason) {
        if (!closed) setError(reason instanceof Error ? reason.message : "Codeタスクを読み込めませんでした");
      } finally {
        if (!closed) setLoading(false);
      }
    };
    setTask(null);
    setError(null);
    void load();
    if (!live) return () => { closed = true; };
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [live, open, taskId, state]);

  const output = task ? latestCodeOutput(task) : "";
  const preview = output.length > 4_000 ? `${output.slice(0, 4_000)}\n…（以降省略）` : output;
  const loop = task?.goalLoopSummary;
  const loopActive = Boolean(loop && LIVE_GOAL_LOOP_STATUSES.has(loop.status));
  const loopTurn = loop ? Math.max(0, Math.trunc(loop.turnCount)) + (loop.status === "queued" ? 1 : 0) : 0;
  const loopTotal = loop && Number.isFinite(loop.maxTurns) ? Math.max(0, Math.trunc(loop.maxTurns)) : 0;
  const loopShownTurn = loopTotal > 0 ? Math.min(loopTurn, loopTotal) : loopTurn;
  const loopPercent = loopTotal > 0 ? Math.round((loopShownTurn / loopTotal) * 100) : null;
  const todoProgress = task?.todoProgress;
  const todoTotal = todoProgress && Number.isFinite(todoProgress.total) ? Math.trunc(todoProgress.total) : 0;
  const todoCompleted = todoTotal > 0 && todoProgress && Number.isFinite(todoProgress.completed)
    ? Math.min(todoTotal, Math.max(0, Math.trunc(todoProgress.completed)))
    : 0;
  const todoPercent = todoTotal > 0 ? Math.round((todoCompleted / todoTotal) * 100) : 0;
  const progressText = loopActive
    ? loopPercent === null ? `ループ ${loopShownTurn}ターン実行中（無制限）` : `ループ ${loopShownTurn}/${loopTotal}ターン（${loopPercent}%）`
    : `ToDo ${todoCompleted}/${todoTotal}件完了（${todoPercent}%）`;
  const progressPercent = loopActive ? loopPercent : todoPercent;
  const progressTotal = loopActive ? (loopPercent === null ? undefined : 100) : todoTotal;
  const progressValue = loopActive ? loopPercent ?? undefined : todoCompleted;
  const succeeded = state === "delivered" && (outcome === undefined || SUCCESS_OUTCOMES.has(outcome));
  // Rooms push the live tool label with the message; the Bot screen derives it from the polled task.
  const runningLabel = activity || (live ? activeToolLabel(task?.messages?.at(-1)) : undefined);
  const changedFiles = changedFilePaths(task?.messages);

  return (
    <div className="mt-2 w-full max-w-full min-w-0 rounded-xl border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" aria-live={live ? "polite" : undefined} className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${succeeded ? "bg-success-bg text-success" : "bg-surface-2 text-muted"}`}>{outcome && !succeeded ? outcome : CODE_STATE_TEXT[state]}</span>
        <span className="min-w-0 flex-1 basis-48 break-words font-medium [overflow-wrap:anywhere]">{prompt || "Code依頼"}</span>
        {runningLabel && <span className="min-w-0 flex-1 truncate text-faint">· {runningLabel}</span>}
        {taskId && <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="min-h-11 rounded-lg px-3 text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">{open ? "閉じる" : "プレビュー"}</button>}
        {taskId && <a className="inline-flex min-h-11 items-center rounded-lg px-3 text-muted hover:bg-surface-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent" href={`/task/${encodeURIComponent(taskId)}`}>実行内容を見る</a>}
        {live && onStop && <button type="button" onClick={onStop} disabled={stopping} className="min-h-11 rounded-lg px-3 text-danger hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">{state === "queued" ? "取消" : "停止"}</button>}
      </div>
      {((loopActive && loopTurn > 0) || (!loopActive && todoTotal > 0)) && (
        <div className="mt-2" title={progressText}>
          <div
            role="progressbar"
            aria-label={loopActive ? "Codeのループ進捗" : "CodeのToDo進捗"}
            aria-valuemin={loopActive && loopPercent === null ? undefined : 0}
            aria-valuemax={progressTotal}
            aria-valuenow={progressValue}
            aria-valuetext={progressText}
            className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          >
            <div className={`h-full rounded-full transition-[width] ${loopPercent === null ? "animate-pulse" : progressPercent === 100 ? "bg-success" : "bg-working"}`} style={{ width: `${progressPercent ?? 35}%` }} />
          </div>
          <p className="mt-1 text-right text-xs text-faint">{progressText}</p>
        </div>
      )}
      {goalLoop?.blockedReason && <p className="mt-2 text-xs text-warning">{"阻害要因: "}{goalLoop.blockedReason}</p>}
      {(goalLoop?.rejectedClaims ?? 0) > 0 && <p className="mt-1 text-xs text-muted">{"完了宣言の却下: "}{goalLoop?.rejectedClaims}{"回"}</p>}
      {open && (
        <div role="region" aria-label="Codeプレビュー" className="mt-3 min-w-0 space-y-3 border-t border-border pt-3">
          {loading && !task && <p className="text-muted">読み込み中…</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          {task && <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1 break-words font-medium" title={task.title}>{task.title}</span>
              <span className="text-muted">{task.status === "error" ? TASK_STATUS_TEXT.error : outcome ?? (state === "delivered" ? "完了" : state === "cancelled" ? "中断" : TASK_STATUS_TEXT[task.status])}</span>
            </div>
            {task.projectName && <p className="truncate text-muted">プロジェクト: {task.projectName}</p>}
            {goalLoop?.acceptance?.length ? (
              <div>
                <p className="font-medium">承認条件</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{goalLoop.acceptance.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]">{item}</li>)}</ul>
              </div>
            ) : null}
            {goalLoop?.summary && <p className="text-muted [overflow-wrap:anywhere]">要約: {goalLoop.summary}</p>}
            {changedFiles.length > 0 && (
              <div>
                <p className="font-medium">{"変更したファイル"}{`（${changedFiles.length}件）`}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{changedFiles.map((path) => <li key={path} className="[overflow-wrap:anywhere]">{path}</li>)}</ul>
              </div>
            )}
            {task.todoProgress && task.todoProgress.total > 0 && <p className="text-muted">進捗: {task.todoProgress.completed}/{task.todoProgress.total}</p>}
            {preview ? <div tabIndex={0} aria-label="Codeの出力" className="max-h-96 overflow-auto rounded-lg bg-bg p-3 text-sm leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent"><BotMessageMarkdown text={preview} /></div> : <p className="text-muted">{live ? "Codeの出力を待っています…" : "Codeの出力はありません"}</p>}
          </>}
          {!loading && !error && !task && <p className="text-muted">Codeタスク情報がありません</p>}
        </div>
      )}
    </div>
  );
}
