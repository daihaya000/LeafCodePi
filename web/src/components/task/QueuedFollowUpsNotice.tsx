"use client";

import { X } from "lucide-react";
import type { ComposerAttachment } from "@/components/Composer";

export type QueuedFollowUp = {
  id: number;
  text: string;
  attachments: ComposerAttachment[];
};

export function QueuedFollowUpsNotice({
  items,
  onRemove,
}: {
  items: QueuedFollowUp[];
  onRemove: (id: number) => void;
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
          <button
            key={item.id}
            type="button"
            title="キューから削除"
            aria-label={`キューから削除: ${label}`}
            onClick={() => onRemove(item.id)}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          >
            <span className="text-faint">{index + 1}.</span>
            <span className="max-w-56 truncate">{label}</span>
            <X className="h-3 w-3 shrink-0" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
