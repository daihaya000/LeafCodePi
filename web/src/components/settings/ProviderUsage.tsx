"use client";

import { cx } from "@/components/ui";
import {
  clampPercent,
  formatResetsIn,
  percentTone,
  type CodexBarProvider,
  type UsageTone,
} from "@/lib/codexbar";

const barClass: Record<UsageTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-danger",
};

const textClass: Record<UsageTone, string> = {
  ok: "text-muted",
  warn: "text-warning",
  danger: "text-danger",
};

/** CodexBar と同じ期間・内訳を、集約せずアカウントごとに表示する。 */
export function ProviderUsage({ usage }: { usage: CodexBarProvider }) {
  const windows = usage.windows ?? [];
  if (windows.length === 0 && usage.usedPercent == null && usage.credits) {
    return null;
  }
  const rows = windows.length > 0
    ? windows
    : [{ id: "usage", title: "使用量", usedPercent: usage.usedPercent, resetsAt: usage.resetsAt }];
  const now = Date.now();

  return (
    <div className="mt-1 space-y-2">
      {rows.map((row, index) => {
        const title = row.title || "使用量";
        const percent = row.usedPercent ?? null;
        const tone = percentTone(percent);
        const resets = formatResetsIn(row.resetsAt, now);
        const percentLabel = percent === null ? "—" : `${Math.round(percent)}%`;
        return (
          <div key={`${row.id}:${index}`}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 text-muted">{title}</span>
              <span className={cx("shrink-0 tabular-nums", textClass[tone])}>
                {percentLabel}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent === null ? undefined : clampPercent(percent)}
              aria-valuetext={percentLabel}
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className={cx("h-full rounded-full transition-all", barClass[tone])}
                style={{ width: `${clampPercent(percent)}%` }}
              />
            </div>
            {resets && (
              <p className="mt-1 text-right text-xs text-muted">リセット {resets}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
