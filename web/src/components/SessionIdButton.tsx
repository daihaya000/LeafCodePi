"use client";

import { useRef, useState } from "react";

/** Show the Pi session ID, never the WebUI task ID. */
export function SessionIdButton({ sessionId }: { sessionId: string | null | undefined }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    if (!sessionId) return;

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sessionId);
        copied = true;
      }
    } catch {
      // HTTP origins and denied Clipboard API permissions need the legacy path.
    }

    if (!copied) {
      const input = inputRef.current;
      const previousFocus = document.activeElement as HTMLElement | null;
      try {
        if (!input) throw new Error("Missing session ID input");
        input.focus({ preventScroll: true });
        input.select();
        input.setSelectionRange(0, input.value.length);
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        previousFocus?.focus({ preventScroll: true });
      }
    }

    setCopyStatus(copied ? "copied" : "error");
  }

  const title = !sessionId
    ? "セッションIDはまだ発行されていない"
    : copyStatus === "copied"
      ? "コピーした"
      : copyStatus === "error"
        ? "コピーできなかった"
        : "クリックでコピー、ドラッグで選択";

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        aria-label="PiセッションID（クリックでコピー、ドラッグで選択）"
        autoComplete="off"
        spellCheck={false}
        readOnly
        disabled={!sessionId}
        size={Math.max(sessionId?.length ?? 0, 4)}
        value={sessionId ?? "未発行"}
        title={title}
        onClick={() => void copy()}
        className="min-w-0 max-w-full shrink cursor-text select-text rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
      />
      <span role="status" aria-live="polite" className="sr-only">
        {copyStatus === "copied" ? "セッションIDをコピーした" : copyStatus === "error" ? "コピーできなかった" : ""}
      </span>
    </>
  );
}
