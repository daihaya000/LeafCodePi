"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import { taskIdFromPathname } from "@/lib/task-panes";
import { playAttentionRequiredSound } from "@/lib/session-complete-sound";
import type { AttentionItemDto } from "@/lib/types";

/**
 * 本家 LeafCode の GlobalAttentionProvider 相当。
 *
 * 全タスクの承認待ち・質問をポーリング監視し、新しい注意アイテムが出現したら
 * 注意音を鳴らしてモーダルを自動オープンする（テキスト入力中は開けない。
 * focusout 後に再試行。本家と同じ）。
 *
 * ponytail: 4 秒間隔の全件ポーリング。LAN ツール前提。タスク数が数百を超える
 * ようなら /api/tasks への SSE 購読か差分 API に上げる。
 */

const POLL_INTERVAL_MS = 4_000;

function attentionItemKey(item: AttentionItemDto): string {
  return `${item.taskId}:${item.kinds.join("+")}`;
}

function hasEditingFocus(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement ||
    focused?.getAttribute("contenteditable") === "true"
  );
}

export function GlobalAttentionProvider() {
  const router = useRouter();
  const [items, setItems] = useState<AttentionItemDto[]>([]);
  const [open, setOpen] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // 二重オープン防止（本家 autoOpenedRef と同じ）。
  const autoOpenedRef = useRef(true);
  const itemsRef = useRef<AttentionItemDto[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const tryAutoOpen = useCallback(() => {
    if (autoOpenedRef.current || hasEditingFocus() || itemsRef.current.length === 0) {
      return false;
    }
    autoOpenedRef.current = true;
    setOpen(true);
    return true;
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await getJson<{ attention: AttentionItemDto[] }>(
          "/api/tasks",
          { attention: "1" },
        );
        if (closed) return;
        const next = data.attention ?? [];
        // 新規アイテム（種類の増分も含む）だけ検出して音を鳴らす。
        const fresh = next.filter((item) => !seenIdsRef.current.has(attentionItemKey(item)));
        for (const item of next) seenIdsRef.current.add(attentionItemKey(item));
        setItems(next);

        if (fresh.length > 0) {
          const activeTaskId = taskIdFromPathname(window.location.pathname);
          const onlyActive = fresh.every((item) => item.taskId === activeTaskId);
          // 表示中タスク自身の要求は TaskView 側の注意音で鳴るため二重再生しない。
          if (!onlyActive) playAttentionRequiredSound();
          autoOpenedRef.current = false;
          tryAutoOpen();
        }
      } catch {
        /* ポーリング失敗は無視（次回再試行） */
      }
    };

    const loop = () => {
      void poll().finally(() => {
        if (!closed) timer = setTimeout(loop, POLL_INTERVAL_MS);
      });
    };
    void poll();
    timer = setTimeout(loop, POLL_INTERVAL_MS);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
  }, [tryAutoOpen]);

  // 入力中は自動オープンできないため、フォーカスが外れたら再試行（本家と同じ）。
  useEffect(() => {
    if (open) return;
    const onFocusOut = () => {
      setTimeout(() => {
        if (autoOpenedRef.current) return;
        if (tryAutoOpen()) window.removeEventListener("focusout", onFocusOut);
      }, 0);
    };
    window.addEventListener("focusout", onFocusOut);
    return () => window.removeEventListener("focusout", onFocusOut);
  }, [open, tryAutoOpen]);

  // 手動クローズ後は同じバッチで再オープンしない（新規アイテムでリセット）。
  const close = () => {
    setOpen(false);
    autoOpenedRef.current = true;
  };

  const openTask = (taskId: string) => {
    close();
    router.push(`/task/${taskId}`);
  };

  if (!open || items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="閉じる"
        onClick={close}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="注意が必要なタスク"
        className="relative w-full max-w-md rounded-2xl border border-border bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-accent">
          <BellRing className="h-4 w-4" />
          承認・回答が必要です
        </div>
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.taskId}>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text" title={item.title}>
                  {item.title}
                </span>
                {item.kinds.includes("question") && <Badge tone="accent">質問</Badge>}
                {item.kinds.includes("permission") && <Badge tone="warning">承認</Badge>}
                <Button variant="secondary" size="sm" onClick={() => openTask(item.taskId)}>
                  開く
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={close}>
            後で
          </Button>
        </div>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "accent" | "warning"; children: string }) {
  return (
    <span
      className={cx(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "accent" ? "bg-accent/10 text-accent" : "bg-warning/15 text-warning",
      )}
    >
      {children}
    </span>
  );
}
