"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import { Button } from "@/components/ui";

/** Show the Pi session ID, never the WebUI task ID. */
export function SessionIdButton({ sessionId }: { sessionId: string | null | undefined }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    dialogRef.current?.close();
  }, [sessionId]);

  async function copy() {
    if (!sessionId) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sessionId);
        setCopyStatus("copied");
        return;
      }
    } catch {
      // HTTP origins and denied Clipboard API permissions need the legacy path.
    }

    const input = inputRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    try {
      // Reuse the input inside the modal: elements appended to body are inert.
      if (!input) throw new Error("Missing session ID input");
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, input.value.length);
      setCopyStatus(document.execCommand("copy") ? "copied" : "error");
    } catch {
      setCopyStatus("error");
    } finally {
      previousFocus?.focus({ preventScroll: true });
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        aria-label="セッションIDを確認"
        title={sessionId ? `セッションID: ${sessionId}` : "セッションIDはまだ発行されていない"}
        disabled={!sessionId}
        className="h-6 shrink-0 px-2 text-xs font-normal text-muted/60 hover:text-muted"
        onClick={() => {
          setCopyStatus("idle");
          dialogRef.current?.showModal();
        }}
      >
        ID
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="fixed inset-0 m-auto w-96 max-w-[calc(100%-2rem)] rounded-xl border border-border bg-surface p-4 text-text shadow-lg backdrop:bg-bg/60"
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-sm font-semibold">セッションID</h2>
          <Button variant="ghost" size="icon" aria-label="セッションIDを閉じる" onClick={() => dialogRef.current?.close()}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <input
          ref={inputRef}
          aria-label="完全なセッションID"
          readOnly
          value={sessionId ?? ""}
          className="mb-4 w-full min-w-0 rounded-lg border border-border bg-bg px-2 py-2 font-mono text-xs text-text"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button variant="secondary" onClick={() => void copy()}>
          <Copy className="h-4 w-4" /> IDをコピー
        </Button>
        <p role="status" className="mt-2 text-xs text-muted">
          {copyStatus === "copied" ? "コピーした" : copyStatus === "error" ? "コピーできなかった。IDを選択して手動でコピーできる。" : "Intercomなどで使うPiのセッションID。"}
        </p>
      </dialog>
    </>
  );
}
