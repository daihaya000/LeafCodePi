"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui";
import { sendJson } from "@/lib/client";
import { notifyTasksChanged } from "@/lib/events";
import { saveForkDraft, type ForkTaskResult } from "@/lib/task-fork";

function ForkDialog({ taskId, entryId, onClose }: { taskId: string; entryId: string; onClose: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function fork() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<ForkTaskResult>(`/api/tasks/${encodeURIComponent(taskId)}/fork`, { entryId });
      saveForkDraft(result.task.id, { text: result.text, images: result.images, files: result.files });
      notifyTasksChanged();
      router.push(`/task/${encodeURIComponent(result.task.id)}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "分岐に失敗しました");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); if (!inFlight.current) onClose(); }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-surface p-4 text-text shadow-xl backdrop:bg-black/40"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold"><GitBranch className="h-4 w-4 text-accent" />ここから分岐</h2>
      <p id={descriptionId} className="mt-3 text-sm text-muted">この発言の直前までの履歴を別セッションへコピーし、発言と添付を入力欄に戻す。編集してから送信できる。</p>
      <p className="mt-2 text-xs text-muted">元の会話は変更しない。作業ファイルは共有され、巻き戻り・分離は行われない。</p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-11 sm:h-8" disabled={busy} onClick={onClose}>キャンセル</Button>
        <Button variant="primary" size="sm" className="h-11 sm:h-8" busy={busy} onClick={() => void fork()}>分岐して編集</Button>
      </div>
    </dialog>
  );
}

export function ForkButton({ taskId, entryId }: { taskId: string; entryId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" title="この発言から別セッションへ分岐" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-3 active:text-text touch-manipulation sm:min-h-0 sm:py-0.5">
      <GitBranch className="h-3 w-3" aria-hidden="true" />ここから分岐
    </button>
    {open && <ForkDialog taskId={taskId} entryId={entryId} onClose={() => setOpen(false)} />}
  </>;
}
