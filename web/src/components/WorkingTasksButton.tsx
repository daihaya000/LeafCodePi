"use client";

import { Columns2, Loader2 } from "lucide-react";
import { cx } from "@/components/ui";

export function WorkingTasksButton({
  hasWorking,
  mdUp,
  busy,
  compact = false,
  onClick,
  className,
}: {
  hasWorking?: boolean;
  mdUp: boolean;
  busy?: boolean;
  compact?: boolean;
  onClick: () => void;
  className?: string;
}) {
  const title = !mdUp
    ? "進行中タスクの分割表示はデスクトップで利用できます"
    : hasWorking === false
      ? "進行中・未読のタスクはないためホームを表示"
      : "進行中・未読タスクを分割表示";
  return (
    <button
      type="button"
      aria-label="進行中タスクを分割表示"
      title={title}
      disabled={!mdUp || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={cx(
        compact
          ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          : "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
        "text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Columns2 className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}
