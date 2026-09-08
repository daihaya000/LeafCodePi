"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { withMentions } from "@/components/bot/BotMention";
import { toolLabel } from "@/lib/tool-labels";
import type { BotDto, UiMessage } from "@/lib/types";
import type { BotAvatarShape } from "@/lib/bot-avatar";

/** Elements that carry prose; each rewrites only its own bare text into mention chips. */
const MENTION_TAGS = ["p", "li", "strong", "em", "td", "th", "h1", "h2", "h3", "h4", "blockquote"] as const;

export function BotMessageMarkdown({ text, mentions, keyPrefix = "md", prefix }: { text: string; mentions?: BotDto[]; keyPrefix?: string; prefix?: ReactNode }) {
  const components = mentions?.length
    ? Object.fromEntries(MENTION_TAGS.map((Tag) => [Tag, ({ children, ...props }: { children?: ReactNode }) => (
      <Tag {...props}>{withMentions(children, mentions, keyPrefix)}</Tag>
    )]))
    : undefined;
  return <div className={prefix ? "md [&>p:first-of-type]:inline" : "md"}>{prefix}<Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
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
  avatar: { name: string; color?: string; shape?: BotAvatarShape; image?: string | null };
}) {
  const running = activeTool(messages);
  const action = running ? toolLabel(running.tool, running.state.input) : "考え中";
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 max-w-bubble items-center gap-2 text-xs text-muted">
      <span aria-hidden="true" className="shrink-0"><BotAvatar size={24} color={avatar.color} shape={avatar.shape} image={avatar.image} name={avatar.name} active /></span>
      <span className="shrink-0 font-medium">応答中…</span>
      <span aria-hidden="true" className="text-faint">·</span>
      <span className="min-w-0 truncate text-faint">{action}</span>
    </div>
  );
}

/** Sender line above the bubble, mirroring Code mode's meta header. */
export function BotMessageSender({ name, color, shape, image, active = false }: { name: string; color?: string; shape?: BotAvatarShape; image?: string | null; active?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] font-medium text-muted">
      <span aria-hidden="true" className="shrink-0"><BotAvatar size={16} color={color} shape={shape} image={image} name={name} active={active} /></span>
      <span className="min-w-0 truncate">{name}</span>
    </div>
  );
}

/** One chat row. Bot and Room conversations share it so both look identical. */
export function BotMessageRow({ user, createdAt, children, footer, header }: { user: boolean; createdAt: number; children: ReactNode; footer?: ReactNode; header?: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 ${user ? "items-end" : "items-start"}`}>
      {header}
      <div className={`min-w-0 max-w-bubble rounded-3xl px-4 py-3 text-base leading-7 [overflow-wrap:anywhere] ${user ? "bg-bot-user text-white" : "rounded-tl-lg bg-bot-assistant text-text"}`}>{children}</div>
      <BotMessageTime createdAt={createdAt} />
      {footer}
    </div>
  );
}

export function BotMessageError({ text }: { text: string }) {
  return <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">{text}</div>;
}

export function BotMessageTime({ createdAt }: { createdAt: number }) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={date.toISOString()} className="mt-1 block text-right text-[11px] opacity-70">{date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>;
}
