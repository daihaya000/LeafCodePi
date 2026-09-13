"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, ScrollText } from "lucide-react";
import { cx, formatDuration, useToolElapsedMs } from "@/components/ui";
import { clampScrollTop, isNearBottom, nextStickState } from "@/lib/scroll-stick";
import type { UiPart } from "@/lib/types";

export const conversationViewportClass = "min-h-0 min-w-0 flex-1 overscroll-y-contain overflow-x-clip overflow-y-auto bg-bot-chat px-3 py-5 sm:px-4";
export const conversationContentClass = "relative mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4";
export const messageRowClass = "flex w-full min-w-0 flex-col gap-2";
export function messageRowClassFor(user: boolean): string {
  return cx(messageRowClass, user ? "items-end" : "items-start");
}

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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [open, setOpen] = useState(false);
  // 展開中はタイムラインと同じ追従ルール（明示的な上スクロールだけ追従解除）。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!open || !scroller || !content) return;
    const pin = () => {
      if (!stickRef.current) return;
      const { scrollHeight, clientHeight } = scroller;
      const nextTop = clampScrollTop(scrollHeight, clientHeight, scrollHeight);
      if (scroller.scrollTop !== nextTop) scroller.scrollTop = nextTop;
      lastTopRef.current = scroller.scrollTop;
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open]);
  return (
    <details
      data-bot-tool-group={kind === "bot" ? "" : undefined}
      data-task-tool-group={kind === "task" ? "" : undefined}
      aria-label="作業ログ"
      onToggle={(event) => {
        // 開き直しは常に最新から見せる。
        if (event.currentTarget.open) stickRef.current = true;
        setOpen(event.currentTarget.open);
      }}
      className="group/tool-activity w-full min-w-0 max-w-bubble self-start overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-surface-2 px-3 py-2.5 text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/tool-activity:rotate-90" aria-hidden="true" />
        <ScrollText className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">作業ログ</span>
        <span className="shrink-0 text-xs text-faint">{count}件{elapsedMs > 0 ? ` · ${formatDuration(elapsedMs)}` : ""}</span>
      </summary>
      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const prevTop = lastTopRef.current;
          lastTopRef.current = el.scrollTop;
          stickRef.current = nextStickState(stickRef.current, el.scrollTop, prevTop, isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
        }}
        className="max-h-[min(28rem,50dvh)] min-w-0 overflow-y-auto overscroll-y-contain border-t border-border bg-surface p-2 [&_.max-w-bubble]:max-w-full"
      >
        <div ref={contentRef} className="min-w-0 space-y-2">{children}</div>
      </div>
    </details>
  );
}
