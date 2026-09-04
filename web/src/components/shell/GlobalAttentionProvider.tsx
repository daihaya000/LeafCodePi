"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { PermissionAdvice } from "@/components/task/PermissionAdvice";
import { QuestionCard } from "@/components/task/QuestionCard";
import { getJson, sendJson } from "@/lib/client";
import { taskIdFromPathname } from "@/lib/task-panes";
import { playAttentionRequiredSound } from "@/lib/session-complete-sound";
import type {
  AttentionItemDto,
  PermissionRequestDto,
  QuestionRequestDto,
  TaskDetail,
} from "@/lib/types";

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

/** Task composer sits in the same corner; lift the bell above the send button. */
export const ATTENTION_BELL_BOTTOM_HOME = "bottom-[max(1rem,env(safe-area-inset-bottom))]";
export const ATTENTION_BELL_BOTTOM_TASK =
  "bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+4.5rem))]";

function attentionItemKey(item: AttentionItemDto): string {
  return `${item.taskId}:${item.kinds.join("+")}`;
}

/** Hide items whose loaded details have explicitly cleared every pending kind. */
export function attentionItemStillOpen(
  item: AttentionItemDto,
  detail: Pick<TaskDetail, "permissionRequest" | "questionRequest"> | undefined,
): boolean {
  if (!detail) return true;
  return !item.kinds.every((kind) => {
    if (kind === "permission") return detail.permissionRequest === null;
    if (kind === "question") return detail.questionRequest === null;
    return false;
  });
}

/** Ignore a stale GET that still carries a request the user already answered. */
export function applyFetchedAttentionDetail(
  incoming: TaskDetail,
  clearedPermissionIds: ReadonlySet<string>,
  clearedQuestionIds: ReadonlySet<string>,
): TaskDetail {
  const permission = incoming.permissionRequest;
  const question = incoming.questionRequest;
  return {
    ...incoming,
    permissionRequest:
      permission != null && clearedPermissionIds.has(permission.id) ? null : permission,
    questionRequest:
      question != null && clearedQuestionIds.has(question.id) ? null : question,
  };
}

/** Drop resolved items so a later request on the same task can alert again. */
export function takeFreshAttentionItems(
  seen: Set<string>,
  next: AttentionItemDto[],
): AttentionItemDto[] {
  const nextKeys = new Set(next.map(attentionItemKey));
  for (const key of [...seen]) {
    if (!nextKeys.has(key)) seen.delete(key);
  }
  const fresh = next.filter((item) => !seen.has(attentionItemKey(item)));
  for (const item of next) seen.add(attentionItemKey(item));
  return fresh;
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
  const pathname = usePathname();
  const activeTaskId = taskIdFromPathname(pathname);
  const [items, setItems] = useState<AttentionItemDto[]>([]);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  const [open, setOpen] = useState(false);
  const [responseBusy, setResponseBusy] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // 二重オープン防止（本家 autoOpenedRef と同じ）。
  const autoOpenedRef = useRef(true);
  const itemsRef = useRef<AttentionItemDto[]>([]);
  const itemsKeyRef = useRef("");
  const clearedPermissionIdsRef = useRef(new Set<string>());
  const clearedQuestionIdsRef = useRef(new Set<string>());

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
        // 解消済みキーは捨てる。残すと同じタスクの次の承認で音もモーダルも出ない。
        const fresh = takeFreshAttentionItems(seenIdsRef.current, next);
        // 実質的な内容が変わらなければ state 参照を維持し、モーダルの再レンダーを避ける。
        const key = next.map((item) => attentionItemKey(item)).join("|");
        // tryAutoOpen は itemsRef を見る。setItems の effect を待つと、
        // 入力中でなくてもモーダルが focusout まで開かない。
        itemsRef.current = next;
        if (key !== itemsKeyRef.current) {
          itemsKeyRef.current = key;
          setItems(next);
        }

        if (fresh.length > 0) {
          const currentTaskId = taskIdFromPathname(window.location.pathname);
          const onlyActive = fresh.every((item) => item.taskId === currentTaskId);
          // 表示中タスク自身の要求は TaskView インライン UI が担当する。
          // 音もモーダルも二重化しない（両方「許可」できてしまう）。
          if (!onlyActive) {
            playAttentionRequiredSound();
            autoOpenedRef.current = false;
            tryAutoOpen();
          }
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
    loop();
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

  useEffect(() => {
    if (!open || items.length === 0) return;
    let cancelled = false;
    void Promise.all(
      items.map(async (item) => {
        try {
          const data = await getJson<{ task: TaskDetail }>(`/api/tasks/${item.taskId}`);
          return [item.taskId, data.task] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDetails((current) => {
        const incoming = Object.fromEntries(
          entries.filter((entry): entry is readonly [string, TaskDetail] => entry !== null),
        );
        const next = { ...current };
        for (const [taskId, task] of Object.entries(incoming)) {
          next[taskId] = applyFetchedAttentionDetail(
            task,
            clearedPermissionIdsRef.current,
            clearedQuestionIdsRef.current,
          );
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // details を deps に含めると setDetails のたびに再実行され、/api/tasks/:id の
    // 再フェッチループになるため除外する。items は実質変更時のみ setItems される
    // （poll 側の itemsKeyRef ガード）ので、この effect は変更時のみ走る。
  }, [items, open]);

  const close = () => {
    setResponseError(null);
    setOpen(false);
    autoOpenedRef.current = true;
  };

  const respondToPermission = async (taskId: string, request: PermissionRequestDto, approved: boolean) => {
    setResponseBusy(request.id);
    setResponseError(null);
    try {
      await sendJson(`/api/tasks/${taskId}/permission`, {
        requestId: request.id,
        approved,
      });
      clearedPermissionIdsRef.current.add(request.id);
      setDetails((current) => ({
        ...current,
        [taskId]: { ...current[taskId], permissionRequest: null },
      }));
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : "承認の送信に失敗しました");
    } finally {
      setResponseBusy(null);
    }
  };

  const respondToQuestion = async (taskId: string, request: QuestionRequestDto, answers: string[][]) => {
    await sendJson(`/api/tasks/${taskId}/question`, { requestId: request.id, answers });
    clearedQuestionIdsRef.current.add(request.id);
    setDetails((current) => ({
      ...current,
      [taskId]: { ...current[taskId], questionRequest: null },
    }));
  };

  const openTask = (taskId: string) => {
    close();
    router.push(`/task/${taskId}`);
  };

  const visibleItems = items.filter((item) =>
    attentionItemStillOpen(item, details[item.taskId]),
  );
  const reopenableCount = visibleItems.filter((item) => item.taskId !== activeTaskId).length;
  if (visibleItems.length === 0) return null;
  if (!open) {
    if (reopenableCount === 0) return null;
    return (
      <button
        type="button"
        aria-label={`承認・回答が必要なタスク ${reopenableCount} 件`}
        onClick={() => setOpen(true)}
        className={cx(
          "fixed right-4 z-[80] flex h-12 min-w-12 items-center justify-center gap-1 rounded-full border border-warning/40 bg-warning-bg px-3 text-sm font-semibold text-warning shadow-lg",
          activeTaskId ? ATTENTION_BELL_BOTTOM_TASK : ATTENTION_BELL_BOTTOM_HOME,
        )}
      >
        <BellRing className="h-4 w-4" aria-hidden="true" />
        <span>{reopenableCount}</span>
      </button>
    );
  }

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
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-accent">
          <BellRing className="h-4 w-4" />
          承認・回答が必要です
        </div>
        {responseError && (
          <p className="mb-3 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger" role="alert">
            {responseError}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {visibleItems.map((item) => {
            const detail = details[item.taskId];
            const question = detail?.questionRequest;
            const permission = detail?.permissionRequest;
            const handledInline = item.taskId === activeTaskId;
            return (
              <li key={item.taskId} className="rounded-xl border border-border bg-surface-2 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-text" title={item.title}>
                    {item.title}
                  </span>
                  {item.kinds.includes("question") && <Badge tone="accent">質問</Badge>}
                  {item.kinds.includes("permission") && <Badge tone="warning">承認</Badge>}
                  <Button variant="ghost" size="sm" onClick={() => openTask(item.taskId)}>
                    開く
                  </Button>
                </div>
                {handledInline && (question || permission || !detail) && (
                  <p className="text-xs text-muted">このタスクの画面で応答できます</p>
                )}
                {!handledInline && question && (
                  <QuestionCard
                    request={question}
                    onReply={(request, answers) => respondToQuestion(item.taskId, request, answers)}
                    onReject={(request) =>
                      sendJson(`/api/tasks/${item.taskId}/question`, {
                        requestId: request.id,
                        reject: true,
                      }).then(() => {
                        clearedQuestionIdsRef.current.add(request.id);
                        setDetails((current) => ({
                          ...current,
                          [item.taskId]: { ...current[item.taskId], questionRequest: null },
                        }));
                      })
                    }
                  />
                )}
                {!handledInline && permission && (
                  <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-3 text-sm">
                    <p className="whitespace-pre-wrap break-words text-warning">{permission.message}</p>
                    <pre className="mt-2 max-h-32 overflow-auto rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text">
                      {permission.command}
                    </pre>
                    <PermissionAdvice taskId={item.taskId} requestId={permission.id} />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        busy={responseBusy === permission.id}
                        disabled={responseBusy !== null}
                        onClick={() => void respondToPermission(item.taskId, permission, true)}
                      >
                        許可
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        busy={responseBusy === permission.id}
                        disabled={responseBusy !== null}
                        onClick={() => void respondToPermission(item.taskId, permission, false)}
                      >
                        拒否
                      </Button>
                    </div>
                  </div>
                )}
                {!handledInline && !detail && <p className="text-xs text-muted">内容を読み込んでいます…</p>}
              </li>
            );
          })}
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
