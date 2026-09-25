"use client";

import { useMemo } from "react";
import { cx, formatDuration } from "@/components/ui";
import { formatTokens, type ContextUsageDto } from "@/lib/context-usage";
import { formatTokensPerSecond } from "@/lib/token-throughput";
import type { UiMessage } from "@/lib/types";

/** Code（TaskView）ヘッダーと同じ集計: 合計出力tok → 平均tok/s → 合計時間。 */
export function botUsageStats(messages: UiMessage[]) {
  let totalOutputTokens = 0;
  let durationMs = 0;
  let rateSum = 0;
  let rateCount = 0;
  let prevCreatedAt: number | null = null;
  for (const message of messages) {
    if (message.role === "user" || message.role === "compaction") continue;
    if (typeof message.outputTokens === "number" && message.outputTokens > 0) totalOutputTokens += message.outputTokens;
    if (typeof message.tokensPerSecond === "number" && Number.isFinite(message.tokensPerSecond) && message.tokensPerSecond > 0) {
      rateSum += message.tokensPerSecond;
      rateCount += 1;
    }
    if (prevCreatedAt !== null) durationMs += Math.max(0, message.createdAt - prevCreatedAt);
    prevCreatedAt = message.createdAt;
  }
  return {
    totalOutputTokens,
    avgRate: rateCount > 0 ? rateSum / rateCount : null,
    durationMs: messages.length > 1 ? durationMs : 0,
  };
}

function ContextUsageMeter({ usage }: { usage: ContextUsageDto }) {
  const pct = usage.percent;
  const usedLabel = usage.tokens === null ? "?" : formatTokens(usage.tokens);
  const limitLabel = formatTokens(usage.contextWindow);
  const pctLabel = pct === null ? "?" : `${pct}%`;
  return (
    <span className="flex shrink-0 items-center gap-1 @min-[500px]/bot:gap-1.5" title={`コンテキスト使用量: ${usedLabel} / ${limitLabel} トークン（${pctLabel}）`}>
      <span className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-surface-2 @min-[500px]/bot:h-1.5 @min-[500px]/bot:w-10">
        <span
          className={cx(
            "block h-full rounded-full transition-[width]",
            pct === null ? "bg-faint" : pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-accent",
          )}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className="whitespace-nowrap tabular-nums">{usedLabel}/{limitLabel} ({pctLabel})</span>
    </span>
  );
}

export function BotUsageStats({ messages, contextUsage }: { messages: UiMessage[]; contextUsage?: ContextUsageDto }) {
  const stats = useMemo(() => botUsageStats(messages), [messages]);
  if (!contextUsage && stats.totalOutputTokens <= 0 && stats.avgRate === null && stats.durationMs <= 0) return null;
  return (
    <span aria-label="セッション情報" className="flex h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden text-[10px] @min-[500px]/bot:text-[11px]">
      {contextUsage && <ContextUsageMeter usage={contextUsage} />}
      {stats.totalOutputTokens > 0 && <span className="shrink-0 tabular-nums" title="合計出力トークン">{formatTokens(stats.totalOutputTokens)} tok</span>}
      {stats.avgRate !== null && <span className="shrink-0 tabular-nums" title="平均 tok/s">{formatTokensPerSecond(stats.avgRate)}</span>}
      {stats.durationMs > 0 && <span className="shrink-0 tabular-nums" title="合計生成時間（メッセージ間隔の累計）">{formatDuration(stats.durationMs)}</span>}
    </span>
  );
}
