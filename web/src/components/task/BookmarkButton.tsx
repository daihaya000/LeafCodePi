"use client";

import { Bookmark } from "lucide-react";
import { cx } from "@/components/ui";

/**
 * Bookmark toggle in a message's action line (beside 「ここから分岐」 under a user message, alone under
 * an assistant one). Same size and tint as its neighbours; 44px tall on phones, like ForkButton.
 * The name states the action, so the button carries no aria-pressed on top of it.
 */
export function BookmarkButton({ bookmarked, onToggle }: { bookmarked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={bookmarked ? "ブックマークを外す" : "ブックマークに追加"}
      title={bookmarked ? "ブックマークを外す" : "ブックマークに追加"}
      onClick={onToggle}
      className={cx(
        "inline-flex min-h-11 touch-manipulation items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors sm:min-h-0 sm:py-0.5",
        bookmarked ? "text-accent hover:bg-surface-2" : "text-faint hover:bg-surface-2 hover:text-muted active:bg-surface-3 active:text-text",
      )}
    >
      <Bookmark className="h-3 w-3" fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />
      {bookmarked ? "ブックマーク済み" : "ブックマーク"}
    </button>
  );
}
