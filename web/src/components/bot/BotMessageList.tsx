"use client";

import { memo, type AnchorHTMLAttributes, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RotateCcw } from "lucide-react";
import { BotAvatar, type BotFace } from "@/components/bot/BotAvatar";
import { ProjectIcon } from "@/components/ProjectIcon";
import { renderMentions, withMentions } from "@/components/bot/BotMention";
import { ImageLightbox } from "@/components/Composer";
import { toolLabel } from "@/lib/tool-labels";
import { Button, formatMessageTime } from "@/components/ui";
import type { BotDto, ProjectDto, TaskSummary, UiMessage } from "@/lib/types";

/** Elements that carry prose; each rewrites only its own bare text into mention chips. */
const MENTION_TAGS = ["p", "li", "strong", "em", "td", "th", "h1", "h2", "h3", "h4", "blockquote"] as const;

function linkBareTaskPaths(text: string) {
  return text.replace(/(^|\s)((\/task\/)[^\s<>()[\]{}]+)/g, (match, prefix: string, path: string) => `${prefix}[${path}](${path})`);
}

function TaskLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || !/^\/task\/[^/?#]+(?:[?#].*)?$/.test(href)) return <a href={href} {...props}>{children}</a>;
  return <InternalTaskLink href={href} {...props} />;
}

function InternalTaskLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const taskId = decodeURIComponent(href.split("/task/")[1]!.split(/[?#]/)[0]!);
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [project, setProject] = useState<Pick<ProjectDto, "id" | "name" | "icon"> | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch(`/api/tasks/${encodeURIComponent(taskId)}`).then((response) => response.ok ? response.json() : null),
      fetch("/api/projects").then((response) => response.ok ? response.json() : null),
    ]).then(([taskResult, projectsResult]) => {
      if (!active) return;
      const nextTask = taskResult?.task as TaskSummary | undefined;
      setTask(nextTask ?? null);
      const nextProject = (projectsResult?.projects as ProjectDto[] | undefined)?.find((item) => item.id === nextTask?.projectId);
      setProject(nextProject ? { id: nextProject.id, name: nextProject.name, icon: nextProject.icon } : null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [taskId]);
  const title = task?.title || taskId;
  return (
    <Link href={href} {...props} aria-label={title} className="my-2 flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm no-underline transition-colors hover:bg-surface-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true">{project && <ProjectIcon project={project} className="flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-semibold" />}</span>
      <span className="min-w-0 truncate font-medium text-text">{title}</span>
    </Link>
  );
}

export const BotMessageMarkdown = memo(function BotMessageMarkdown({ text, mentions, keyPrefix = "md" }: { text: string; mentions?: BotDto[]; keyPrefix?: string }) {
  const components = mentions
    ? Object.fromEntries(MENTION_TAGS.map((Tag) => [Tag, ({ children, ...props }: { children?: ReactNode }) => (
      <Tag {...props}>{withMentions(children, mentions, keyPrefix)}</Tag>
    )]))
    : undefined;
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={{ ...components, a: ({ href, children, ...props }) => <TaskLink href={href} {...props}>{children}</TaskLink> }}>{linkBareTaskPaths(text)}</Markdown></div>;
});

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
export function BotMessageRow({ user, createdAt, children, footer, header, after, bubble = true, timeInHeader = false }: { user: boolean; createdAt: number; children: ReactNode; footer?: ReactNode; header?: ReactNode; after?: ReactNode; bubble?: boolean; timeInHeader?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${user ? "items-end" : "items-start"}`}>
      {header}
      {bubble && <div className={`min-w-0 max-w-bubble rounded-3xl px-4 py-3 text-base leading-7 [overflow-wrap:anywhere] bot-message-bubble ${user ? "bg-bot-user text-white" : "rounded-tl-lg bg-bot-assistant text-text"}`}>{children}</div>}
      {after}
      {(!timeInHeader || user) && <BotMessageTime createdAt={createdAt} />}
      {footer}
    </div>
  );
}

/** Shared conversation presentation; callers supply only conversation-specific content/actions. */
export function BotChatMessage({ user, createdAt, sender, text, mentions = [], children, images, footer, after, bubble = true }: {
  user: boolean;
  createdAt: number;
  sender: BotFace & { name: string; active?: boolean };
  text: string;
  mentions?: BotDto[];
  children?: ReactNode;
  images?: ReactNode;
  footer?: ReactNode;
  after?: ReactNode;
  bubble?: boolean;
}) {
  return <BotMessageRow user={user} createdAt={createdAt} timeInHeader={!user}
    header={user ? undefined : <BotMessageSender {...sender} createdAt={createdAt} />} footer={footer} after={after} bubble={bubble}>
    {text && (user
      ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderMentions(text, mentions, "user", "user")}</div>
      : <BotMessageMarkdown text={text} mentions={mentions} />)}
    {images}
    {children}
  </BotMessageRow>;
}

/** Bot and Room share these chrome pieces; keep new shared bot-chat UI in this file so the two views cannot drift. */
export function BotRevertButton({ title, disabled, onClick }: { title: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" title={title} disabled={disabled} onClick={onClick} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-3 active:text-text disabled:opacity-40 touch-manipulation"><RotateCcw className="h-3 w-3" />入力欄に戻す</button>;
}

export function BotMessageImages({ images }: { images: { key: string; src: string; alt?: string }[] }) {
  if (images.length === 0) return null;
  return <div className="mb-2 flex flex-wrap gap-2">{images.map((image) => <ImageLightbox key={image.key} src={image.src} alt={image.alt ?? "添付画像"} className="max-h-48 max-w-full rounded-xl object-contain" />)}</div>;
}

export function BotPermissionCard({ label, title, message, command, disabled, onAllow, onDeny }: {
  label: string;
  title: string;
  message: string;
  command: string;
  disabled?: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={label} className="rounded-2xl border border-warning/40 bg-warning-bg p-4 text-xs">
      <p className="font-medium">{title}</p>
      <p className="mt-1 whitespace-pre-wrap break-all text-muted">{message}</p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-2">{command}</pre>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={disabled} onClick={onAllow}>許可</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onDeny}>拒否</Button>
      </div>
    </div>
  );
}

export function BotMessageError({ text }: { text: string }) {
  return <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">{text}</div>;
}

export function BotMessageTime({ createdAt, className = "mt-1 block text-right" }: { createdAt: number; className?: string }) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={date.toISOString()} className={`${className} text-[11px] opacity-70`}>{formatMessageTime(createdAt)}</time>;
}
