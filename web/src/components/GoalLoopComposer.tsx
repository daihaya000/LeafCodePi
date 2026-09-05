"use client";

import { useEffect, useState } from "react";
import { ListTodo } from "lucide-react";
import { cx } from "@/components/ui";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS,
  formatGoalLoopCooldownSeconds,
} from "@/lib/goal-loop-settings";

export const GOAL_LOOP_FORCE_FULL_RUN_HINT =
  "完了宣言を使わず、指定の最大ターン数まで必ず実行します";
export const GOAL_LOOP_COOLDOWN_LABEL = "クールタイム";
export const GOAL_LOOP_COOLDOWN_HINT =
  "次のターンを開始するまでの待機時間です。15m 30sのように入力できます。0で待機なし。";

export function GoalLoopToggle({
  enabled,
  disabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
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
        className,
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
  cooldownSeconds = DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS,
  disabled,
  onAcceptanceChange,
  onMaxTurnsChange,
  onCooldownSecondsChange,
  onForceFullRunChange,
}: {
  acceptance: string;
  maxTurns: number;
  forceFullRun: boolean;
  cooldownSeconds?: number;
  disabled?: boolean;
  onAcceptanceChange: (value: string) => void;
  onMaxTurnsChange: (value: number) => void;
  onCooldownSecondsChange?: (value: number) => void;
  onForceFullRunChange: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(maxTurns));
  useEffect(() => setDraft(String(maxTurns)), [maxTurns]);
  const [cooldownDraft, setCooldownDraft] = useState(
    formatGoalLoopCooldownSeconds(cooldownSeconds),
  );
  useEffect(
    () => setCooldownDraft(formatGoalLoopCooldownSeconds(cooldownSeconds)),
    [cooldownSeconds],
  );

  function commitMaxTurns() {
    const value = clampGoalLoopMaxTurns(draft, 1);
    setDraft(String(value));
    if (value !== maxTurns) onMaxTurnsChange(value);
  }

  function commitCooldown() {
    const value = clampGoalLoopCooldownSeconds(cooldownDraft);
    setCooldownDraft(formatGoalLoopCooldownSeconds(value));
    if (value !== cooldownSeconds) onCooldownSecondsChange?.(value);
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border bg-surface-2/50 p-3 md:p-2">
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-start">
        {!forceFullRun && (
          <textarea
            value={acceptance}
            disabled={disabled}
            onChange={(event) => onAcceptanceChange(event.target.value)}
            rows={2}
            placeholder="承認条件（任意・1行に1つ）"
            aria-label="承認条件"
            className="min-h-20 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary md:min-h-0 md:min-w-0 md:flex-1"
          />
        )}
        <label className="flex min-h-11 w-full items-center justify-between gap-1.5 text-xs text-muted md:min-h-0 md:w-auto md:shrink-0">
          <span title="0で無制限">最大ターン</span>
          <input
            type="number"
            min={0}
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
            className="h-11 w-24 rounded-lg border border-border bg-bg px-2 text-sm text-text outline-none focus:border-primary md:h-8 md:w-16"
          />
        </label>
        <label
          className="flex min-h-11 w-full items-center justify-between gap-1.5 text-xs text-muted md:min-h-0 md:w-auto md:shrink-0"
          title={GOAL_LOOP_COOLDOWN_HINT}
        >
          {GOAL_LOOP_COOLDOWN_LABEL}
          <input
            type="text"
            inputMode="text"
            value={cooldownDraft}
            disabled={disabled}
            aria-label={GOAL_LOOP_COOLDOWN_LABEL}
            placeholder="15m 30s"
            onChange={(event) => setCooldownDraft(event.target.value)}
            onBlur={commitCooldown}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitCooldown();
              }
            }}
            className="h-11 w-24 rounded-lg border border-border bg-bg px-2 text-sm text-text outline-none focus:border-primary md:h-8"
          />
        </label>
      </div>
      <label className="flex min-h-11 w-full cursor-pointer items-start gap-2 py-2 text-xs text-muted" title={GOAL_LOOP_FORCE_FULL_RUN_HINT}>
        <input
          type="checkbox"
          checked={forceFullRun}
          disabled={disabled}
          aria-label="完走モード"
          onChange={(event) => onForceFullRunChange(event.target.checked)}
          className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
        />
        <span>
          完走モード
          <span className="ml-1 text-faint">（完了宣言なし・指定ターン数を必ず実行）</span>
        </span>
      </label>
    </div>
  );
}
