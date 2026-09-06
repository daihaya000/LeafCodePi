"use client";

import type { ChangeEventHandler, CompositionEventHandler, KeyboardEventHandler, ReactNode, RefObject } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";

export function BotComposer({
  value,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  inputRef,
  placeholder,
  sendDisabled,
  busy,
  onSend,
  onAbort,
  footer,
  inputOverlay,
}: {
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  sendDisabled?: boolean;
  busy?: boolean;
  onSend: () => void;
  onAbort?: () => void;
  footer?: ReactNode;
  inputOverlay?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-t border-border bg-bg px-3 py-3">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm focus-within:border-accent/60">
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <textarea ref={inputRef} value={value} onChange={onChange} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={onKeyDown} placeholder={placeholder} rows={1} className="min-h-10 w-full resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-faint" />
            {inputOverlay}
          </div>
          <button type="button" aria-label="添付または追加" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"><Plus className="h-4 w-4" /></button>
          {busy && onAbort ? <Button onClick={onAbort} variant="danger">停止</Button> : <Button onClick={onSend} disabled={sendDisabled || busy}>送信</Button>}
        </div>
        {footer && <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}
