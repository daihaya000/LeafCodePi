"use client";

import { type ChangeEventHandler, type CompositionEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [value]);
  return (
    <div className="shrink-0 bg-bot-chat px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
      <div className="bot-composer-shell mx-auto w-full rounded-3xl border border-bot-outline bg-bot-panel px-2 py-1 transition-colors focus-within:border-accent/60">
        <div className="flex items-end gap-2">
          {footer && <button type="button" aria-label="会話のオプション" aria-expanded={optionsOpen} aria-controls={optionsId} onClick={() => setOptionsOpen((open) => !open)} className="mb-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"><Plus className="h-5 w-5" /></button>}
          <div className="relative min-w-0 flex-1">
            <textarea ref={(element) => { textareaRef.current = element; if (inputRef) inputRef.current = element; }} aria-label={placeholder} value={value} onChange={onChange} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={onKeyDown} placeholder={placeholder} rows={1} className="block min-h-11 max-h-40 w-full resize-none overflow-y-auto bg-transparent px-0 py-2.5 text-base leading-6 outline-none placeholder:text-faint" />
            {inputOverlay}
          </div>
          {busy && onAbort ? (
            <button type="button" onClick={onAbort} aria-label="応答を停止" title="応答を停止" className="mb-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger text-white transition-opacity hover:opacity-90"><Square className="h-3.5 w-3.5 fill-current" /></button>
          ) : (
            <button type="button" onClick={onSend} aria-label="送信" title={sendDisabled ? "メッセージを入力してください" : "送信"} disabled={!canSend} className={`mb-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${sendDisabled || busy ? "bg-surface-3 text-muted" : "bg-accent text-white hover:bg-accent/90"}`}><ArrowUp className="h-4 w-4" /></button>
          )}
        </div>
        {footer && <div id={optionsId} hidden={!optionsOpen} className="border-t border-bot-outline px-2 py-2 text-xs text-muted">{optionsOpen && <div className="flex flex-wrap items-center gap-3">{footer}</div>}</div>}
      </div>
    </div>
  );
}
