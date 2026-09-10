"use client";

import { type ChangeEventHandler, type ClipboardEventHandler, type CompositionEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Plus, Square, UsersRound, Wrench } from "lucide-react";
import { COMPOSER_ACTION_BUTTON_CLASS, ImageLightbox, type ComposerAttachment, type ComposerReferences } from "@/components/Composer";
import { composerReferenceInsertion, composerReferenceToolNames, filterComposerReferences, findComposerReferenceToken, type ComposerReference } from "@/lib/composer-references";
import { isImeComposingEvent } from "@/lib/composer-ime";

type BotComposerProps = {
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (index: number) => void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
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
  references?: ComposerReferences;
  onValueChange?: (value: string) => void;
};

export function BotComposer({
  value,
  onChange,
  attachments,
  onRemoveAttachment,
  onPaste,
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
  references,
  onValueChange,
}: BotComposerProps) {
  const canSend = !sendDisabled && !busy;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const optionsId = useId();
  const referenceOptionsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const availableReferences = useMemo(
    () => ({ skills: references?.skills ?? [], agents: references?.agents ?? [] }),
    [references?.agents, references?.skills],
  );
  const currentToken = useMemo(
    () => findComposerReferenceToken(value, caret),
    [caret, value],
  );
  const suggestions = useMemo(() => {
    if (!currentToken) return [];
    const source = currentToken.kind === "skill" ? availableReferences.skills : availableReferences.agents;
    return filterComposerReferences(source, currentToken.query);
  }, [availableReferences.agents, availableReferences.skills, currentToken]);
  const showSuggestions = focused && Boolean(onValueChange) && suggestions.length > 0;

  useEffect(() => {
    setActiveSuggestion(0);
  }, [currentToken?.kind, currentToken?.query]);

  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    setCaret(input.selectionStart ?? value.length);
  }, [value]);

  const refreshCaret = (input = textareaRef.current) => {
    if (input) setCaret(input.selectionStart ?? value.length);
  };

  const chooseSuggestion = (reference: ComposerReference) => {
    const input = textareaRef.current;
    const token = currentToken;
    if (!input || !token || !onValueChange) return;
    const inserted = composerReferenceInsertion(token, reference.name);
    onValueChange(`${value.slice(0, token.start)}${inserted}${value.slice(token.end)}`);
    setFocused(true);
    setActiveSuggestion(0);
    requestAnimationFrame(() => {
      const nextCaret = token.start + inserted.length;
      input.focus();
      input.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  return (
    <div className="shrink-0 bg-bot-chat px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
      <div className="bot-composer-shell mx-auto w-full rounded-3xl border border-bot-outline/70 bg-bot-panel px-2 py-1 transition-[border-color,box-shadow] focus-within:border-bot-outline">
        {attachments && attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map((attachment, index) => <span key={`${attachment.uri}-${index}`} className="relative overflow-hidden rounded-lg border border-border"><ImageLightbox src={attachment.uri} alt={attachment.name ?? "添付画像"} className="h-16 w-16 object-cover" /><button type="button" aria-label={`${index + 1}番目の画像を削除`} onClick={() => onRemoveAttachment?.(index)} className="absolute right-0 top-0 rounded-bl bg-black/60 px-1 text-xs text-white">×</button></span>)}</div>}
        <div className="flex items-end gap-2">
          {footer && <button type="button" aria-label="会話のオプション" aria-expanded={optionsOpen} aria-controls={optionsId} onClick={() => setOptionsOpen((open) => !open)} className={`${COMPOSER_ACTION_BUTTON_CLASS} mb-1 bg-surface-2 text-muted hover:bg-surface-3 hover:text-text`}><Plus className="h-4 w-4" /></button>}
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={(element) => { textareaRef.current = element; if (inputRef) inputRef.current = element; }}
              aria-label={placeholder}
              value={value}
              onChange={(event) => { onChange(event); refreshCaret(event.currentTarget); }}
              onClick={(event) => refreshCaret(event.currentTarget)}
              onKeyUp={(event) => refreshCaret(event.currentTarget)}
              onSelect={(event) => refreshCaret(event.currentTarget)}
              onFocus={(event) => { setFocused(true); refreshCaret(event.currentTarget); }}
              onBlur={() => {
                setFocused(false);
                // compositionEnd 欠落で stuck すると候補確定ショートカットが死ぬ
                composingRef.current = false;
              }}
              onPaste={onPaste}
              onCompositionStart={(event) => { composingRef.current = true; onCompositionStart?.(event); }}
              onCompositionEnd={(event) => { composingRef.current = false; onCompositionEnd?.(event); refreshCaret(event.currentTarget); }}
              onKeyDown={(event) => {
                if (showSuggestions && !composingRef.current && !isImeComposingEvent(event)) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveSuggestion((index) => (index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                    return;
                  }
                  if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
                    event.preventDefault();
                    const selected = suggestions[activeSuggestion];
                    if (selected && currentToken) chooseSuggestion(selected);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setFocused(false);
                    return;
                  }
                }
                onKeyDown(event);
              }}
              placeholder={placeholder}
              rows={1}
              aria-autocomplete={showSuggestions ? "list" : undefined}
              aria-controls={showSuggestions ? referenceOptionsId : undefined}
              className="block min-h-11 max-h-40 w-full resize-none overflow-y-auto bg-transparent px-0 py-2.5 text-base leading-6 outline-none placeholder:text-faint"
            />
            {showSuggestions && currentToken && (
              <div id={referenceOptionsId} role="listbox" aria-label={currentToken.kind === "skill" ? "スキル候補" : "エージェント候補"} className="absolute bottom-full left-0 z-30 mb-2 max-h-56 w-full min-w-64 overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                {suggestions.map((reference, index) => {
                  const selected = index === activeSuggestion;
                  return <button key={`${currentToken.kind}-${reference.name}`} type="button" role="option" aria-selected={selected} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(reference)} className={`flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left ${selected ? "bg-surface-2" : "hover:bg-surface-2"}`}>
                    {currentToken.kind === "skill" ? <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-accent">{reference.name}</span>{currentToken.kind === "agent" && <span className="mt-1 flex flex-wrap gap-1" aria-label="ツール権限">{composerReferenceToolNames(reference).map((tool) => <span key={tool} data-tool-permission={tool} className="rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{tool}</span>)}</span>}{reference.description && <span className="mt-0.5 block truncate text-[11px] text-muted">{reference.description}</span>}</span>
                  </button>;
                })}
              </div>
            )}
            {inputOverlay}
          </div>
          {busy && onAbort ? (
            <button type="button" onClick={onAbort} aria-label="応答を停止" title="応答を停止" className={`${COMPOSER_ACTION_BUTTON_CLASS} mb-1 bg-danger text-white hover:opacity-90`}><Square className="h-4 w-4 fill-current" /></button>
          ) : (
            <button type="button" onClick={onSend} aria-label="送信" title={sendDisabled ? "メッセージを入力してください" : "送信"} disabled={!canSend} className={`${COMPOSER_ACTION_BUTTON_CLASS} mb-1 ${sendDisabled || busy ? "bg-surface-3 text-muted" : "bg-accent text-white hover:bg-accent/90"}`}><ArrowUp className="h-4 w-4" /></button>
          )}
        </div>
        {footer && <div id={optionsId} hidden={!optionsOpen} className="border-t border-bot-outline px-2 py-2 text-xs text-muted">{optionsOpen && <div className="flex flex-wrap items-center gap-3">{footer}</div>}</div>}
      </div>
    </div>
  );
}
