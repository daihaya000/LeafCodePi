"use client";

import type { ReactNode } from "react";
import { ChevronRight, Logs } from "lucide-react";
import { cx, formatDuration, useToolElapsedMs } from "@/components/ui";
import type { UiPart } from "@/lib/types";

export const conversationViewportClass = "min-h-0 min-w-0 flex-1 overscroll-y-contain overflow-x-clip overflow-y-auto bg-bot-chat px-3 py-5 sm:px-4";
export const conversationContentClass = "relative mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4";
export const messageRowClass = "flex w-full min-w-0 flex-col gap-2";

export function MessageHeader({ user = false, children }: { user?: boolean; children: ReactNode }) {
  return <div className={cx("flex min-w-0 max-w-bubble items-center gap-1.5 px-1 text-[11px] text-muted", user ? "ml-auto justify-end" : "w-full self-start justify-start")}>{children}</div>;
}

export function MessageBubble({ user = false, neutral = false, className, children }: { user?: boolean; neutral?: boolean; className?: string; children: ReactNode }) {
  return <div className={cx(
    "min-w-0 max-w-bubble rounded-3xl px-4 py-3 text-base leading-7 [overflow-wrap:anywhere]",
    user ? "ml-auto self-end" : "w-full self-start rounded-tl-lg",
    user && !neutral ? "bg-bot-user text-white" : "bg-bot-assistant text-text",
    className,
  )}>{children}</div>;
}

/** Keep Bot/Code log icons and layout here to prevent drift; callers own grouping and metadata. */
export function ActivityLog({ children, count, parts, active, kind }: {
  children: ReactNode;
  count: number;
  parts: readonly UiPart[];
  active: boolean;
  kind: "bot" | "task";
}) {
  const elapsedMs = useToolElapsedMs(parts, active);
  return (
    <details
      data-bot-tool-group={kind === "bot" ? "" : undefined}
      data-task-tool-group={kind === "task" ? "" : undefined}
      aria-label="作業ログ"
      className="group/tool-activity w-full min-w-0 max-w-bubble self-start overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-surface-2 px-3 py-2.5 text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/tool-activity:rotate-90" aria-hidden="true" />
        <Logs className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">作業ログ</span>
        <span className="shrink-0 text-xs text-faint">{count}件{elapsedMs > 0 ? ` · ${formatDuration(elapsedMs)}` : ""}</span>
      </summary>
      <div className="max-h-[min(28rem,50dvh)] min-w-0 space-y-2 overflow-y-auto overscroll-y-contain border-t border-border bg-surface p-2 [&_.max-w-bubble]:max-w-full">
        {children}
      </div>
    </details>
  );
}
