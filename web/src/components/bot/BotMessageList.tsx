"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";

export function BotMessageList({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const viewport = useRef<HTMLElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => { following.current = true; }, [conversationId]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [children, conversationId]);

  return (
    <main ref={viewport} onScroll={(event) => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    }} className="min-h-0 flex-1 overflow-y-auto bg-bot-chat px-3 py-5 sm:px-4">
      {children}
    </main>
  );
}

export function BotMessageTime({ createdAt }: { createdAt: number }) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={date.toISOString()} className="mt-1 block text-right text-[11px] opacity-70">{date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>;
}
