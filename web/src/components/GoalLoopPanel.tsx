"use client";

import { useEffect, useState } from "react";
import { Check, CircleAlert, ListTodo, Pause, Play, Square } from "lucide-react";
import { Button, cx } from "@/components/ui";
import type { GoalLoopDto } from "@/lib/types";

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

export function GoalLoopPanel({
  loop,
  busy,
  onAction,
  onResume,
}: {
  loop: GoalLoopDto | null | undefined;
  busy: boolean;
  onAction: (action: "pause" | "stop") => void;
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
  const commitMaxTurns = () =>
    onResume(Math.min(100, Math.max(loop.maxTurns + 1, Math.trunc(Number(maxTurns) || loop.maxTurns + 1))));

  return (
    <section
      aria-label="Goal loop"
      className={cx(
        "mx-auto mb-2 max-w-3xl rounded-xl border border-border bg-surface p-3 text-sm",
        live && "border-primary/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ListTodo className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="font-medium">ループ</span>
        <span className={cx("rounded-full px-2 py-0.5 text-[11px]", badgeClass(loop.status))}>
          {labels[loop.status]} {Math.min(turn, loop.maxTurns)}/{loop.maxTurns}
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
          {canResume && (
            <>
              {turnLimit && (
                <input
                  type="number"
                  min={loop.maxTurns + 1}
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
                onClick={() => (turnLimit ? commitMaxTurns() : onResume())}
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
