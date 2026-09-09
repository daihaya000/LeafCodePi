"use client";

import { type AnchorHTMLAttributes, type ReactNode, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BotAvatar, type BotFace } from "@/components/bot/BotAvatar";
import { renderMentions, withMentions } from "@/components/bot/BotMention";
import { toolLabel } from "@/lib/tool-labels";
import { formatMessageTime } from "@/components/ui";
import type { BotDto, UiMessage } from "@/lib/types";

/** Elements that carry prose; each rewrites only its own bare text into mention chips. */
const MENTION_TAGS = ["p", "li", "strong", "em", "td", "th", "h1", "h2", "h3", "h4", "blockquote"] as const;

function TaskLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || !/^\/task\/[^/?#]+(?:[?#].*)?$/.test(href)) {
    return <a href={href} {...props}>{children}</a>;
  }
  const taskId = decodeURIComponent(href.split("/task/")[1]!.split(/[?#]/)[0]!);
  return (
    <Link href={href} {...props} className="my-2 flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm no-underline transition-colors hover:bg-surface-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true">↗</span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-muted">Codeタスク</span>
        <span className="block truncate font-medium text-text">{taskId}</span>
      </span>
    </Link>
  );
}

export function BotMessageMarkdown({ text, mentions, keyPrefix = "md" }: { text: string; mentions?: BotDto[]; keyPrefix?: string }) {
  const components = mentions
    ? Object.fromEntries(MENTION_TAGS.map((Tag) => [Tag, ({ children, ...props }: { children?: ReactNode }) => (
      <Tag {...props}>{withMentions(children, mentions, keyPrefix)}</Tag>
    )]))
    : undefined;
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={{ ...components, a: ({ href, children, ...props }) => <TaskLink href={href} {...props}>{children}</TaskLink> }}>{text}</Markdown></div>;
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
  avatar: BotFace & { name: string };
}) {
  const running = activeTool(messages);
  const action = running ? toolLabel(running.tool, running.state.input) : "考え中";
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 max-w-bubble items-center gap-2 text-xs text-muted">
      <span aria-hidden="true" className="shrink-0"><BotAvatar size={24} {...avatar} active /></span>
      <span className="shrink-0 font-medium">応答中…</span>
      <span aria-hidden="true" className="text-faint">·</span>
      <span className="min-w-0 truncate text-faint">{action}</span>
    </div>
  );
}

/** Sender line above the bubble, mirroring Code mode's meta header. */
export function BotMessageSender({ name, createdAt, active = false, ...face }: BotFace & { name: string; createdAt?: number; active?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] font-medium text-muted">
      <span aria-hidden="true" className="shrink-0"><BotAvatar size={16} {...face} name={name} active={active} /></span>
      <span className="min-w-0 truncate">{name}</span>
      {createdAt !== undefined && <BotMessageTime createdAt={createdAt} className="ml-1 mt-0 shrink-0" />}
    </div>
  );
}

/** One chat row. Bot and Room conversations share it so both look identical. */
export function BotMessageRow({ user, createdAt, children, footer, header, timeInHeader = false }: { user: boolean; createdAt: number; children: ReactNode; footer?: ReactNode; header?: ReactNode; timeInHeader?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${user ? "items-end" : "items-start"}`}>
      {header}
      <div className={`min-w-0 max-w-bubble rounded-3xl px-4 py-3 text-base leading-7 [overflow-wrap:anywhere] bot-message-bubble ${user ? "bg-bot-user text-white" : "rounded-tl-lg bg-bot-assistant text-text"}`}>{children}</div>
      {(!timeInHeader || user) && <BotMessageTime createdAt={createdAt} />}
      {footer}
    </div>
  );
}

/** Shared conversation presentation; callers supply only conversation-specific content/actions. */
export function BotChatMessage({ user, createdAt, sender, text, mentions = [], children, images, footer }: {
  user: boolean;
  createdAt: number;
  sender: BotFace & { name: string; active?: boolean };
  text: string;
  mentions?: BotDto[];
  children?: ReactNode;
  images?: ReactNode;
  footer?: ReactNode;
}) {
  return <BotMessageRow user={user} createdAt={createdAt} timeInHeader={!user}
    header={user ? undefined : <BotMessageSender {...sender} createdAt={createdAt} />} footer={footer}>
    {images}
    {text && (user
      ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderMentions(text, mentions, "user", "user")}</div>
      : <BotMessageMarkdown text={text} mentions={mentions} />)}
    {children}
  </BotMessageRow>;
}

export function BotMessageError({ text }: { text: string }) {
  return <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">{text}</div>;
}

export function BotMessageTime({ createdAt, className = "mt-1 block text-right" }: { createdAt: number; className?: string }) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={date.toISOString()} className={`${className} text-[11px] opacity-70`}>{formatMessageTime(createdAt)}</time>;
}
