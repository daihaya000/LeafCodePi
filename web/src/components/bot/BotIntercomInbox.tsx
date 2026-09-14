"use client";

import type { BotIntercomInboxDto } from "@/lib/types";

function oneLine(inbox: BotIntercomInboxDto): string {
  if (!inbox.preview) return "内線メッセージはありません";
  return `${inbox.preview.fromName}: ${inbox.preview.text}`;
}

export function BotIntercomInbox({
  inbox,
  onRead,
}: {
  inbox: BotIntercomInboxDto;
  onRead?: () => void;
}) {
  const unread = inbox.unreadCount > 0;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-bot-outline bg-bot-chat px-4 py-1.5"
      role="status"
      aria-label="内線受信箱"
    >
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
  );
}
