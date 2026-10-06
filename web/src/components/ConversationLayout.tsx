"use client";

import { Children, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Loader2, Minus, ScrollText } from "lucide-react";
import { cx, formatDuration, useToolElapsedMs } from "@/components/ui";
import { formatTokens } from "@/lib/context-usage";
import { clampScrollTop, isNearBottom, nextStickState } from "@/lib/scroll-stick";
import { formatTokensPerSecond, isSlowTokensPerSecond, summarizeThroughput } from "@/lib/token-throughput";
import type { UiMessage, UiPart } from "@/lib/types";

export const conversationViewportClass = "min-h-0 min-w-0 flex-1 overscroll-y-contain overflow-x-clip overflow-y-auto bg-bot-chat px-3 py-5 sm:px-4";
export const conversationContentClass = "relative mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4";
export const messageRowClass = "flex w-full min-w-0 flex-col gap-2";
export function messageRowClassFor(user: boolean): string {
  return cx(messageRowClass, user ? "items-end" : "items-start");
}

export function MessageHeader({ user = false, wide = false, children }: { user?: boolean; wide?: boolean; children: ReactNode }) {
  return <div className={cx("flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-muted", wide ? "@container/meta-header max-w-full" : "max-w-bubble", user ? "ml-auto justify-end" : "w-full self-start justify-start")}>{children}</div>;
}

export function MessageBubble({ user = false, neutral = false, className, children }: { user?: boolean; neutral?: boolean; className?: string; children: ReactNode }) {
  return <div className={cx(
    "min-w-0 max-w-bubble rounded-card px-4 py-3 text-base leading-7 [overflow-wrap:anywhere]",
    user ? "ml-auto self-end" : "w-full self-start",
    user && !neutral ? "bg-bot-user text-white" : "bg-bot-assistant text-text",
    className,
  )}>{children}</div>;
}

/** 作業ログ全体の使用量。見出しのメタ行（Code は MessageMetaHeader、Bot は BotMessageSender）に出す。 */
export type ActivityUsage = { outputTokens: number; avgRate: number | null; elapsedMs: number };

/** メタ行に出す使用量の表記（空文字の項目は出さない）。Code と Bot で表記を揃える。 */
export function activityUsageLabels(usage: ActivityUsage) {
  return {
    tokens: usage.outputTokens > 0 ? `${formatTokens(usage.outputTokens)} tok` : "",
    rate: usage.avgRate === null ? "" : formatTokensPerSecond(usage.avgRate),
    slow: isSlowTokensPerSecond(usage.avgRate),
    elapsed: usage.elapsedMs > 0 ? formatDuration(usage.elapsedMs) : "",
  };
}

const ACTIVITY_LOG_LAZY_THRESHOLD = 25;
const ACTIVITY_LOG_INITIAL_ITEMS = 20;
const ACTIVITY_LOG_PAGE_SIZE = 20;

export const ACTIVITY_USAGE_TITLES = {
  tokens: "作業ログ内の合計出力トークン",
  rate: "作業ログ内の平均 tok/s（各応答の tok/s の平均）",
  elapsed: "作業ログの経過時間（最初の開始から最後の終了まで）",
} as const;

function lastLogStatus(messages: readonly UiMessage[], parts: readonly UiPart[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.error) return "error";
    const tool = message.parts.findLast((part) => part.type === "tool");
    if (tool?.type === "tool") return tool.state.status;
  }
  const tool = parts.findLast((part) => part.type === "tool");
  return tool?.type === "tool" ? tool.state.status : undefined;
}

/** Keep Bot/Code log icons and layout here to prevent drift; callers own grouping and choose which responses count toward usage. */
export function ActivityLog({ children, renderChildren, header, count, parts, messages = [], statusMessages = messages, active, running = false, outcome, kind, revealNonce }: {
  children?: ReactNode;
  /** Defer constructing nested message/tool elements until a large log is opened. */
  renderChildren?: () => ReactNode;
  /** 枠外と展開内容の先頭に出すメタ行。関数なら作業ログ全体の使用量を受け取って描く。 */
  header?: ReactNode | ((usage: ActivityUsage, placement: "outside" | "inside") => ReactNode);
  count: number;
  parts: readonly UiPart[];
  /** 使用量と経過時間に数える応答。本文を吹き出しに出す応答は吹き出し側の応答として含めない。 */
  messages?: readonly UiMessage[];
  /** 状態判定用の全応答。使用量の対象 messages とは独立して最後の実行だけを見る。 */
  statusMessages?: readonly UiMessage[];
  active: boolean;
  /** このログが現在進行中の作業か。active はタブの表示状態。 */
  running?: boolean;
  /** ツールパーツを持たない委譲実行などの最終状態。 */
  outcome?: "completed" | "error" | "cancelled";
  kind: "bot" | "task";
  /** Opens this log (and renders every child) each time the value changes: in-session search and bookmarks use it to reveal a message inside a collapsed log. */
  revealNonce?: number;
}) {
  const elapsedMs = useToolElapsedMs(parts, active, messages);
  const status = outcome ?? lastLogStatus(statusMessages, parts);
  const failed = status === "error";
  const cancelled = status === "cancelled";
  const [headerNode, insideHeaderNode] = typeof header === "function"
    ? (() => {
      const usage = { ...summarizeThroughput(messages), elapsedMs };
      return [header(usage, "outside"), header(usage, "inside")];
    })()
    : [header, header];
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const lastHeightRef = useRef(0);
  const [open, setOpen] = useState(running);
  const [visibleChildCount, setVisibleChildCount] = useState(ACTIVITY_LOG_INITIAL_ITEMS);
  const childItems = open || count < ACTIVITY_LOG_LAZY_THRESHOLD
    ? Children.toArray(renderChildren ? renderChildren() : children)
    : [];
  const renderCount = count >= ACTIVITY_LOG_LAZY_THRESHOLD ? visibleChildCount : childItems.length;
  const visibleChildren = childItems.slice(-renderCount);
  const earlierChildCount = childItems.length - visibleChildren.length;
  // Small groups stay mounted for instant expand; large collapsed historical logs can contain
  // thousands of output nodes, so leave their body out of the DOM until the user opens them.
  const mountBody = open || count < ACTIVITY_LOG_LAZY_THRESHOLD;
  // 作業の開始・完了時だけ開閉を同期し、途中の手動開閉は維持する。
  useLayoutEffect(() => {
    setOpen(running);
  }, [running]);
  // 検索・ブックマークのジャンプ先がこのログ内にあるとき、開いて遅延描画分も出す（手動の開閉は次の通知まで維持）。
  useLayoutEffect(() => {
    if (revealNonce === undefined) return;
    setOpen(true);
    setVisibleChildCount(Number.MAX_SAFE_INTEGER);
  }, [revealNonce]);
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
      lastHeightRef.current = scrollHeight;
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open]);
  // 完了した単一項目は畳まず、メタ行と内容をそのまま表示する。
  if (count < 2 && !running) {
    return <div className="w-full min-w-0 self-start space-y-2">{headerNode}{visibleChildren}</div>;
  }
  const log = (
    <details
      data-bot-tool-group={kind === "bot" ? "" : undefined}
      data-task-tool-group={kind === "task" ? "" : undefined}
      aria-label="作業ログ"
      open={open}
      onToggle={(event) => {
        // 開き直しは常に最新から見せる。
        if (event.currentTarget.open) stickRef.current = true;
        setOpen(event.currentTarget.open);
      }}
      className="group/tool-activity w-full min-w-0 max-w-bubble self-start overflow-hidden rounded-card border border-border bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-surface-2 px-3 py-2.5 text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        <ScrollText className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">作業ログ</span>
        <span className="shrink-0 text-xs text-faint">{count}件</span>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-working" role="img" aria-label="実行中" />
        ) : failed ? (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" role="img" aria-label="エラー" />
        ) : cancelled ? (
          <Minus className="h-3.5 w-3.5 shrink-0 text-muted" role="img" aria-label="中断" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-success/70" role="img" aria-label="完了" />
        )}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint transition-transform group-open/tool-activity:rotate-90" aria-hidden="true" />
      </summary>
      {mountBody && <div
        ref={scrollerRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const prevTop = lastTopRef.current;
          lastTopRef.current = el.scrollTop;
          const layoutChanged = el.scrollHeight !== lastHeightRef.current;
          lastHeightRef.current = el.scrollHeight;
          stickRef.current = nextStickState(stickRef.current, el.scrollTop, prevTop, isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight), undefined, layoutChanged);
        }}
        className="max-h-[min(19.6rem,35dvh)] min-w-0 overflow-y-auto overscroll-y-contain border-t border-border bg-surface p-2 [&_.max-w-bubble]:max-w-full"
      >
        <div ref={contentRef} className="min-w-0 space-y-2">
          {insideHeaderNode}
          {earlierChildCount > 0 && (
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => setVisibleChildCount((current) => Math.min(childItems.length, current + ACTIVITY_LOG_PAGE_SIZE))}
            >
              過去のログをさらに表示（{earlierChildCount}件）
            </button>
          )}
          {visibleChildren}
        </div>
      </div>}
    </details>
  );
  return headerNode ? (
    <div className="w-full min-w-0 self-start space-y-2">
      {headerNode}
      {log}
    </div>
  ) : log;
}
