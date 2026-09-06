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
    <div className="shrink-0 border-t border-border/70 bg-bot-chat px-4 py-4">
      <div className="bot-composer-shell mx-auto max-w-3xl rounded-[1.35rem] border border-bot-outline bg-bot-panel px-4 py-3 transition-colors focus-within:border-accent/60">
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <textarea ref={inputRef} value={value} onChange={onChange} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={onKeyDown} placeholder={placeholder} rows={1} className="min-h-11 w-full resize-none bg-transparent px-2 py-2.5 text-sm leading-5 outline-none placeholder:text-faint" />
            {inputOverlay}
          </div>
          <button type="button" aria-label="添付または追加" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"><Plus className="h-4 w-4" /></button>
          {busy && onAbort ? <Button onClick={onAbort} variant="danger" className="rounded-full px-4">停止</Button> : <Button onClick={onSend} variant="primary" disabled={sendDisabled || busy} className="rounded-full px-4">送信</Button>}
        </div>
        {footer && <div className="mt-2 flex items-center justify-between gap-2 px-2 text-[11px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}
