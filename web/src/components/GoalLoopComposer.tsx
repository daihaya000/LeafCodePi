"use client";

import { useEffect, useState } from "react";
import { ListTodo } from "lucide-react";
import { cx } from "@/components/ui";

export const GOAL_LOOP_FORCE_FULL_RUN_HINT =
  "完了宣言を使わず、指定の最大ターン数まで必ず実行します";

export function GoalLoopToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label="ループで継続実行"
      title="ループで継続実行"
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors disabled:opacity-40",
        enabled
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-bg text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
      ループ
    </button>
  );
}

export function GoalLoopOptions({
  acceptance,
  maxTurns,
  forceFullRun,
  disabled,
  onAcceptanceChange,
  onMaxTurnsChange,
  onForceFullRunChange,
}: {
  acceptance: string;
  maxTurns: number;
  forceFullRun: boolean;
  disabled?: boolean;
  onAcceptanceChange: (value: string) => void;
  onMaxTurnsChange: (value: number) => void;
  onForceFullRunChange: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(maxTurns));
  useEffect(() => setDraft(String(maxTurns)), [maxTurns]);

  function commitMaxTurns() {
    const value = Math.min(100, Math.max(1, Math.trunc(Number(draft) || 1)));
    setDraft(String(value));
    if (value !== maxTurns) onMaxTurnsChange(value);
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border bg-surface-2/50 p-2">
      <div className="flex flex-wrap items-start gap-2">
        {!forceFullRun && (
          <textarea
            value={acceptance}
            disabled={disabled}
            onChange={(event) => onAcceptanceChange(event.target.value)}
            rows={2}
            placeholder="承認条件（任意・1行に1つ）"
            aria-label="承認条件"
            className="min-w-0 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-primary"
          />
        )}
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          最大ターン
          <input
            type="number"
            min={1}
            max={100}
            value={draft}
            disabled={disabled}
            aria-label="最大ターン数"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitMaxTurns}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitMaxTurns();
              }
            }}
            className="h-8 w-16 rounded-lg border border-border bg-bg px-2 text-sm text-text outline-none focus:border-primary"
          />
        </label>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted" title={GOAL_LOOP_FORCE_FULL_RUN_HINT}>
        <input
          type="checkbox"
          checked={forceFullRun}
          disabled={disabled}
          aria-label="完走モード"
          onChange={(event) => onForceFullRunChange(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-border accent-primary"
        />
        <span>
          完走モード
          <span className="ml-1 text-faint">（完了宣言なし・指定ターン数を必ず実行）</span>
        </span>
      </label>
    </div>
  );
}
