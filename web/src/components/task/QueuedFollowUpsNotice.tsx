"use client";

import { X, Zap } from "lucide-react";
import type { ComposerAttachment } from "@/components/Composer";

export type QueuedFollowUp = {
  id: number;
  text: string;
  attachments: ComposerAttachment[];
};

export function QueuedFollowUpsNotice({
  items,
  onRemove,
  onSendNow,
  sendNowDisabled = false,
  hint,
}: {
  items: QueuedFollowUp[];
  onRemove: (id: number) => void;
  onSendNow: (id: number) => void;
  sendNowDisabled?: boolean;
  /** Why the queue is not draining (e.g. a Goal Loop owns the session). */
  hint?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5"
      aria-live="polite"
      aria-label={`キュー待ち ${items.length} 件`}
    >
      <span className="text-xs font-medium text-muted">キュー待ち:</span>
      {items.map((item, index) => {
        const label = item.text.trim() || "画像";
        return (
          <div
            key={item.id}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-muted"
          >
            <span className="text-faint">{index + 1}.</span>
            <span className="max-w-56 truncate" title={label}>{label}</span>
            <button
              type="button"
              title="影響が小さい処理は中断して送信。変更・シェル・不明な処理は安全な区切りで送信"
              aria-label={`即時送信: ${label}`}
              disabled={sendNowDisabled}
              onClick={() => onSendNow(item.id)}
              className="inline-flex items-center gap-0.5 rounded-sm px-1 text-accent hover:text-accent/80 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
              即時送信
            </button>
            <button
              type="button"
              title="キューから削除"
              aria-label={`キューから削除: ${label}`}
              onClick={() => onRemove(item.id)}
              className="rounded-sm text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {hint && (
        <p className="w-full text-xs text-faint" data-queue-hint>
          {hint}
        </p>
      )}
    </div>
  );
}
