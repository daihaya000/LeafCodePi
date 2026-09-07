"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { toolLabel } from "@/lib/tool-labels";
import type { UiMessage } from "@/lib/types";

export function BotMessageMarkdown({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;
}

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

function activeTool(messages: UiMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.type === "tool" && (part.state.status === "pending" || part.state.status === "running")) return part;
    }
    break;
  }
  return null;
}

export function BotResponseStatus({
  messages,
  avatar,
}: {
  messages: UiMessage[];
  avatar: { name: string; color?: string; image?: string | null };
}) {
  const running = activeTool(messages);
  const action = running ? toolLabel(running.tool, running.state.input) : "考え中";
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 max-w-[88%] items-center gap-2 text-xs text-muted">
      <span aria-hidden="true" className="shrink-0"><BotAvatar size={24} color={avatar.color} image={avatar.image} name={avatar.name} active /></span>
      <span className="shrink-0 font-medium">応答中…</span>
      <span aria-hidden="true" className="text-faint">·</span>
      <span className="min-w-0 truncate text-faint">{action}</span>
    </div>
  );
}

export function BotMessageTime({ createdAt }: { createdAt: number }) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={date.toISOString()} className="mt-1 block text-right text-[11px] opacity-70">{date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>;
}
