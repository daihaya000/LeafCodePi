"use client";

import type { BotIntercomInboxDto, BotIntercomInboxItemDto } from "@/lib/types";

function oneLine(inbox: BotIntercomInboxDto): string {
  if (!inbox.preview) return "内線メッセージはありません";
  return `${inbox.preview.fromName}: ${inbox.preview.text}`;
}

function kindLabel(message: BotIntercomInboxItemDto): string | null {
  if (message.kind === "ask") return "質問";
  if (message.kind === "reply") return "返信";
  return null;
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
            return (
              <li key={message.id} className="truncate text-[11px] leading-4 text-muted">
                <span className="font-medium text-text">{message.fromName}</span>
                {tag && <span className="ml-1 text-accent">{tag}</span>}
                <span className="ml-1">{message.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
