"use client";

import type { BotIntercomInboxDto, BotIntercomInboxItemDto, BotIntercomPresence } from "@/lib/types";

function oneLine(inbox: BotIntercomInboxDto): string {
  if (!inbox.preview) return "内線メッセージはありません";
  return `${inbox.preview.fromName}: ${inbox.preview.text}`;
}

function kindLabel(message: BotIntercomInboxItemDto): string | null {
  if (message.cancelled) return "取消";
  if (message.supersededBy) return "差替";
  if (message.kind === "ask") return "質問";
  if (message.kind === "reply") return "返信";
  return null;
}

function presenceLabel(status: BotIntercomPresence): string {
  if (status === "online") return "オンライン";
  if (status === "busy") return "取り込み中";
  return "オフライン";
}

function presenceClass(status: BotIntercomPresence): string {
  if (status === "online") return "bg-emerald-500";
  if (status === "busy") return "bg-amber-500";
  return "bg-muted";
}

export function BotIntercomInbox({
  inbox,
  onRead,
}: {
  inbox: BotIntercomInboxDto;
  onRead?: () => void;
}) {
  const unread = inbox.unreadCount > 0;
  const pending = inbox.pendingAsks ?? [];
  const thread = inbox.messages.slice(-8);
  const presence = inbox.peerPresence;
  return (
    <div
      className="flex shrink-0 flex-col gap-1 border-b border-bot-outline bg-bot-chat px-4 py-1.5"
      role="region"
      aria-label="内線受信箱"
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          {unread && (
            <span
              aria-label="未読"
              className="h-2 w-2 rounded-full bg-accent"
            />
          )}
        </span>
        <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted">
          <span className="mr-1.5 font-medium text-text">内線</span>
          {presence && (
            <span className="mr-1.5 inline-flex items-center gap-1" aria-label={`在席 ${presenceLabel(presence.status)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${presenceClass(presence.status)}`} aria-hidden="true" />
              {presenceLabel(presence.status)}
            </span>
          )}
          {oneLine(inbox)}
        </p>
        {unread && onRead && (
          <button
            type="button"
            onClick={onRead}
            className="shrink-0 text-[11px] text-accent hover:underline"
          >
            既読
          </button>
        )}
      </div>
      {pending.length > 0 && (
        <p className="pl-4 text-[11px] text-accent" aria-label="質問待ち">
          質問待ち · {pending[0]?.fromName}
          {pending.length > 1 ? ` ほか${pending.length - 1}件` : ""}
        </p>
      )}
      {thread.length > 0 && (
        <ol className="max-h-24 space-y-0.5 overflow-y-auto pl-4" aria-label="内線スレッド">
          {thread.map((message) => {
            const tag = kindLabel(message);
            const inactive = Boolean(message.cancelled || message.supersededBy);
            return (
              <li key={message.id} className={`text-[11px] leading-4 text-muted ${inactive ? "line-through opacity-70" : ""}`}>
                <span className="font-medium text-text">{message.fromName}</span>
                {tag && <span className="ml-1 text-accent">{tag}</span>}
                {message.text ? <span className="ml-1">{message.text}</span> : null}
                {message.attachments?.map((attachment) => (
                  <span key={attachment.file} className="ml-1 text-text" aria-label={`添付 ${attachment.name}`}>
                    [{attachment.name}]
                  </span>
                ))}
                <details className="mt-0.5 text-[10px] text-muted">
                  <summary>詳細</summary>
                  {message.id}
                  {message.delivery ? ` · ${message.delivery}` : ""}
                  {` · depth ${message.depth}`}
                  {message.supersedes ? ` · supersedes ${message.supersedes}` : ""}
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
