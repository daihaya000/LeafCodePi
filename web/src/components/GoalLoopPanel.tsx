"use client";

import { useEffect, useState } from "react";
import { Check, CircleAlert, ListTodo, Pause, Play, Square } from "lucide-react";
import { Button, cx } from "@/components/ui";
import type { GoalLoopDto } from "@/lib/types";
import { formatGoalLoopCooldownSeconds } from "@/lib/goal-loop-settings";

const labels: Record<GoalLoopDto["status"], string> = {
  queued: "送信待ち",
  running: "実行中",
  paused: "一時停止",
  verifying_completed: "完了検証中",
  completed: "完了",
  blocked: "ブロック",
  stopped: "停止",
};

function badgeClass(status: GoalLoopDto["status"]): string {
  if (status === "completed") return "bg-success/15 text-success";
  if (status === "blocked") return "bg-warning-bg text-warning";
  if (status === "verifying_completed") return "bg-primary/15 text-primary";
  if (status === "paused" || status === "stopped") return "bg-surface-2 text-muted";
  return "bg-working/15 text-working";
}

const pauseHints: Record<string, string> = {
  user: "ユーザー操作で一時停止しました。再開すると次のターンを送信します。",
  manual_send: "手動送信が行われたため一時停止しました。",
  turn_limit: "最大ターン数に到達しました。完了するか、上限を増やして再開できます。",
  unreadable_result: "結果JSONを繰り返し読めなかったため一時停止しました。",
  turn_timeout: "応答が確認できないまま時間切れになりました。",
  unknown_delivery: "送達が不明なため重複送信を防止して一時停止しました。",
  transcript_unreadable: "会話履歴を読めないため一時停止しました。",
  boundary_lost: "基準メッセージが見つからないため誤読を防止して一時停止しました。",
  verification_rejected: "完了宣言が検証で繰り返し拒否されました。",
  scheduler_error: "スケジューラーでエラーが発生しました。",
};

export function GoalLoopPanel({
  loop,
  busy,
  onAction,
  onResume,
}: {
  loop: GoalLoopDto | null | undefined;
  busy: boolean;
  onAction: (action: "pause" | "stop" | "complete") => void;
  onResume: (maxTurns?: number) => void;
}) {
  const [maxTurns, setMaxTurns] = useState(String(loop?.maxTurns ?? 10));
  useEffect(() => setMaxTurns(String(loop?.maxTurns ?? 10)), [loop?.maxTurns]);

  if (!loop) return null;
  const live = loop.status === "queued" || loop.status === "running" || loop.status === "verifying_completed";
  const canPause = loop.status === "queued" || loop.status === "running" || loop.status === "verifying_completed";
  const canResume = loop.status === "paused";
  const turn = loop.status === "queued" ? loop.turnCount + 1 : loop.turnCount;
  const progress = loop.progress.at(-1);
  const turnLimit = loop.pauseReason === "turn_limit";
  // turn_limit 以外の一時停止（unreadable_result / turn_timeout / scheduler_error 等）でも
  // 予算を使い切っていると /goal-resume が上限増やしを要求するため、入力欄が必要。
  const budgetExhausted = loop.maxTurns > 0 && loop.turnCount >= loop.maxTurns;
  const needsTurns = turnLimit || budgetExhausted;
  const canComplete = loop.status === "paused" && turnLimit;
  const maxTurnsLabel = loop.maxTurns === 0 ? "∞" : String(loop.maxTurns);
  const shownTurn = loop.maxTurns === 0 ? turn : Math.min(turn, loop.maxTurns);
  const progressPercent =
    loop.maxTurns > 0
      ? Math.min(100, Math.max(0, Math.round((shownTurn / loop.maxTurns) * 100)))
      : null;
  const progressValueLabel =
    progressPercent === null
      ? `${shownTurn}ターン実行済み（無制限）`
      : `${shownTurn}/${loop.maxTurns}ターン、${progressPercent}%`;
  const commitMaxTurns = () => {
    const trimmed = maxTurns.trim();
    const parsed = Math.trunc(Number(trimmed));
    // 空欄・不正な入力は「無制限(0)」に解釈せず、最小の増分で再開する。
    // 誤って無制限で再開すると turn_limit で止まらないため（Composer 側は
    // 空欄を 1 に正規化するのに対し、Number("") === 0 が無制限扱いになる不整合）。
    const value =
      trimmed === "" || !Number.isFinite(parsed)
        ? Math.min(100, loop.maxTurns + 1)
        : parsed === 0
          ? 0
          : Math.min(100, Math.max(loop.maxTurns + 1, parsed));
    setMaxTurns(String(value));
    onResume(value);
  };
  const pauseHint = loop.status === "paused" ? pauseHints[loop.pauseReason] : undefined;
  const cooldownActive = Boolean(
    loop.nextTurnAt && Date.parse(loop.nextTurnAt) > Date.now(),
  );

  return (
    <section
      aria-label="Goal loop"
      className={cx(
        "mx-auto mb-2 max-w-5xl rounded-xl border border-border bg-surface p-3 text-sm",
        live && "border-primary/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ListTodo className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="font-medium">ループ</span>
        <span
          className={cx("rounded-full px-2 py-0.5 text-[11px]", badgeClass(loop.status))}
          aria-label={`ループ状態: ${labels[loop.status]}、Goalターン ${shownTurn} / ${loop.maxTurns === 0 ? "無制限" : maxTurnsLabel}`}
        >
          {labels[loop.status]} {shownTurn}/{maxTurnsLabel}
        </span>
        {loop.forceFullRun && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">完走</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted" title={loop.goal}>
          {loop.goal}
        </span>
        <div className="flex shrink-0 gap-1">
          {canPause && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction("pause")}>
              <Pause className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">一時停止</span>
            </Button>
          )}
          {canComplete && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onAction("complete")}>
              <Check className="h-3.5 w-3.5" />完了
            </Button>
          )}
          {canResume && (
            <>
              {needsTurns && (
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={maxTurns}
                  disabled={busy}
                  aria-label="再開後の最大ターン数"
                  onChange={(event) => setMaxTurns(event.target.value)}
                  className="h-8 w-16 rounded-lg border border-border bg-bg px-2 text-xs outline-none focus:border-primary"
                />
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => (needsTurns ? commitMaxTurns() : onResume())}
              >
                <Play className="h-3.5 w-3.5" />再開
              </Button>
            </>
          )}
          {canPause && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => onAction("stop")}>
              <Square className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">停止</span>
            </Button>
          )}
        </div>
      </div>
      {loop.cooldownSeconds > 0 && (
        <p className="mt-2 text-xs text-muted" title="結果適用後に次のターン開始まで待機します">
          クールタイム: {formatGoalLoopCooldownSeconds(loop.cooldownSeconds)}
          {cooldownActive ? "（待機中）" : ""}
        </p>
      )}
      <div className="mt-3 border-t border-border pt-2.5">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-muted">進捗</span>
          <span className="tabular-nums text-faint">
            {progressPercent === null ? "無制限" : `${progressPercent}%`}
          </span>
        </div>
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label="ループ進捗"
          aria-valuemin={progressPercent === null ? undefined : 0}
          aria-valuemax={progressPercent === null ? undefined : 100}
          aria-valuenow={progressPercent ?? undefined}
          aria-valuetext={progressValueLabel}
        >
          <div
            className={cx(
              "h-full rounded-full transition-[width] duration-300",
              loop.status === "completed"
                ? "bg-success"
                : loop.status === "blocked"
                  ? "bg-warning"
                  : "bg-working",
              progressPercent === null && "animate-pulse",
            )}
            style={{ width: `${progressPercent ?? 35}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-faint">{progressValueLabel}</p>
      </div>
      {pauseHint && <p className="mt-2 text-xs text-muted">{pauseHint}</p>}
      {(progress || loop.error || loop.blockedReason) && (
        <div className="mt-2 flex gap-2 border-t border-border pt-2 text-xs text-muted">
          {loop.status === "blocked" ? (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          ) : loop.status === "completed" ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          ) : null}
          <span className="min-w-0 whitespace-pre-wrap">
            {loop.error || loop.blockedReason || progress?.summary}
          </span>
        </div>
      )}
    </section>
  );
}
