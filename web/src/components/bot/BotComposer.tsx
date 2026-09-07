"use client";

import type { ChangeEventHandler, CompositionEventHandler, KeyboardEventHandler, ReactNode, RefObject } from "react";
import { ArrowUp, Plus, Square } from "lucide-react";

type BotComposerProps = {
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
};

export function BotComposer({
  value,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  inputRef,
  placeholder,
  sendDisabled = false,
  busy = false,
  onSend,
  onAbort,
  footer,
  inputOverlay,
}: BotComposerProps) {
  const canSend = !sendDisabled && !busy;
  return (
    <div className="shrink-0 bg-bot-chat px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
      <div className="bot-composer-shell mx-auto max-w-3xl rounded-[1.35rem] border border-bot-outline bg-bot-panel px-4 py-3 transition-colors focus-within:border-accent/60">
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <textarea ref={inputRef} value={value} onChange={onChange} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={onKeyDown} placeholder={placeholder} rows={1} className="min-h-11 w-full resize-none bg-transparent px-2 py-2.5 text-sm leading-5 outline-none placeholder:text-faint" />
            {inputOverlay}
          </div>
          <button type="button" aria-label="添付または追加" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"><Plus className="h-4 w-4" /></button>
          {busy && onAbort ? (
            <button type="button" onClick={onAbort} aria-label="応答を停止" title="応答を停止" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger text-white transition-opacity hover:opacity-90"><Square className="h-3.5 w-3.5 fill-current" /></button>
          ) : (
            <button type="button" onClick={onSend} aria-label="送信" title={sendDisabled ? "メッセージを入力してください" : "送信"} disabled={!canSend} className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${sendDisabled || busy ? "bg-surface-3 text-muted" : "bg-accent text-white hover:bg-accent/90"}`}><ArrowUp className="h-4 w-4" /></button>
          )}
        </div>
        {footer && <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-2 text-[11px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}
