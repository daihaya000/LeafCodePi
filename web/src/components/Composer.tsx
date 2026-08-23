"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  CompositionEventHandler,
  CSSProperties,
  FocusEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";
import { Bot, FileCode2, Paperclip, X } from "lucide-react";
import {
  composerReferenceValue,
  filterComposerReferences,
  findComposerReferenceToken,
  type ComposerReference,
  type ComposerReferenceKind,
} from "@/lib/composer-references";
import { renderHighlightedReferenceText } from "@/components/ReferenceHighlight";

export type { ComposerReference } from "@/lib/composer-references";

export type ComposerAttachment = {
  uri: string;
  mime: string;
  name?: string;
};

export type ComposerReferences = {
  skills?: readonly ComposerReference[];
  agents?: readonly ComposerReference[];
};

type ComposerProps = {
  className: string;
  form?: {
    ariaLabel: string;
    onSubmit: FormEventHandler<HTMLFormElement>;
  };
  attachments: ComposerAttachment[];
  onRemoveAttachment: (index: number) => void;
  attachmentRemovalDisabled?: boolean;
  textarea: {
    ref: RefObject<HTMLTextAreaElement | null>;
    value: string;
    rows: number;
    ariaLabel: string;
    busy?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder: string;
    className: string;
    style?: CSSProperties;
    onChange: ChangeEventHandler<HTMLTextAreaElement>;
    onValueChange?: (value: string) => void;
    onClick?: MouseEventHandler<HTMLTextAreaElement>;
    onKeyUp?: KeyboardEventHandler<HTMLTextAreaElement>;
    onSelect?: ReactEventHandler<HTMLTextAreaElement>;
    onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
    onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
    onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
    onBlur?: FocusEventHandler<HTMLTextAreaElement>;
    onFocus?: FocusEventHandler<HTMLTextAreaElement>;
    onScroll?: UIEventHandler<HTMLTextAreaElement>;
    onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  };
  references?: ComposerReferences;
  attachmentControl: {
    inputRef: RefObject<HTMLInputElement | null>;
    inputDisabled?: boolean;
    buttonDisabled?: boolean;
    buttonTitle: string;
    onFilesSelected: (files: FileList) => void;
    onTrigger: () => void;
  };
  toolbar: ReactNode;
  action: ReactNode;
};

export function Composer({
  className,
  form,
  attachments,
  onRemoveAttachment,
  attachmentRemovalDisabled,
  textarea,
  references,
  attachmentControl,
  toolbar,
  action,
}: ComposerProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const availableReferences = useMemo(
    () => ({ skills: references?.skills ?? [], agents: references?.agents ?? [] }),
    [references?.agents, references?.skills],
  );
  const currentToken = useMemo(
    () => findComposerReferenceToken(textarea.value, caret),
    [caret, textarea.value],
  );
  const suggestions = useMemo(() => {
    if (!currentToken) return [];
    const source = currentToken.kind === "skill" ? availableReferences.skills : availableReferences.agents;
    return filterComposerReferences(source, currentToken.query);
  }, [availableReferences.agents, availableReferences.skills, currentToken]);
  const showSuggestions = focused && !textarea.readOnly && !textarea.disabled && suggestions.length > 0;

  useEffect(() => {
    setActiveSuggestion(0);
  }, [currentToken?.kind, currentToken?.query]);

  useLayoutEffect(() => {
    const element = textarea.ref.current;
    if (!element) return;

    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    setCaret(element.selectionStart ?? textarea.value.length);
  }, [textarea.ref, textarea.rows, textarea.value]);

  function refreshCaret(element = textarea.ref.current) {
    if (element) setCaret(element.selectionStart ?? textarea.value.length);
  }

  function chooseSuggestion(reference: ComposerReference, kind: ComposerReferenceKind) {
    const element = textarea.ref.current;
    const token = currentToken;
    if (!element || !token || !textarea.onValueChange) return;
    const inserted = `${composerReferenceValue(kind, reference.name)} `;
    const next = `${textarea.value.slice(0, token.start)}${inserted}${textarea.value.slice(token.end)}`;
    textarea.onValueChange(next);
    setFocused(true);
    setActiveSuggestion(0);
    requestAnimationFrame(() => {
      const nextCaret = token.start + inserted.length;
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }

  function handleScroll(event: Parameters<UIEventHandler<HTMLTextAreaElement>>[0]) {
    const element = event.currentTarget;
    if (previewRef.current) {
      previewRef.current.scrollTop = element.scrollTop;
      previewRef.current.scrollLeft = element.scrollLeft;
    }
    textarea.onScroll?.(event);
  }

  const highlightedText = renderHighlightedReferenceText(textarea.value, availableReferences);
  useLayoutEffect(() => {
    if (!previewRef.current) return;
    previewRef.current.scrollTop = textarea.ref.current?.scrollTop ?? 0;
    previewRef.current.scrollLeft = textarea.ref.current?.scrollLeft ?? 0;
  }, [textarea.ref, textarea.value]);

  const inner = (
    <>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.uri}-${index}`}
              className="relative inline-flex overflow-hidden rounded-lg border border-border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.uri} alt={attachment.name ?? "添付"} className="h-16 w-16 object-cover" />
              <button
                type="button"
                disabled={attachmentRemovalDisabled}
                aria-label={`${attachment.name ?? "添付画像"}を削除`}
                onClick={() => onRemoveAttachment(index)}
                className="absolute top-0.5 right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface/90 text-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div
          ref={previewRef}
          aria-hidden="true"
          className={`${textarea.className} pointer-events-none absolute inset-0 z-0 max-h-60 overflow-hidden whitespace-pre-wrap break-words text-text`}
          style={textarea.style}
        >
          {highlightedText}
        </div>
        <textarea
          ref={textarea.ref}
          value={textarea.value}
          rows={textarea.rows}
          aria-label={textarea.ariaLabel}
          disabled={textarea.disabled}
          readOnly={textarea.readOnly}
          placeholder={textarea.placeholder}
          className={`${textarea.className} relative z-10 max-h-60 overflow-y-auto text-transparent caret-text selection:bg-primary/20 focus-visible:outline-none`}
          style={textarea.style}
          onChange={(event) => {
            textarea.onChange(event);
            refreshCaret(event.currentTarget);
          }}
          onClick={(event) => {
            textarea.onClick?.(event);
            refreshCaret(event.currentTarget);
          }}
          onKeyUp={(event) => {
            textarea.onKeyUp?.(event);
            refreshCaret(event.currentTarget);
          }}
          onSelect={(event) => {
            textarea.onSelect?.(event);
            refreshCaret(event.currentTarget);
          }}
          onPaste={textarea.onPaste}
          onCompositionStart={(event) => {
            composingRef.current = true;
            textarea.onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            textarea.onCompositionEnd?.(event);
            refreshCaret(event.currentTarget);
          }}
          onFocus={(event) => {
            setFocused(true);
            refreshCaret(event.currentTarget);
            textarea.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            textarea.onBlur?.(event);
          }}
          onScroll={handleScroll}
          onKeyDown={(event) => {
            if (showSuggestions && !composingRef.current) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestion((index) => (index + 1) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestion((index) => (index - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const kind = currentToken?.kind ?? "skill";
                const selected = suggestions[activeSuggestion];
                if (selected) chooseSuggestion(selected, kind);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setFocused(false);
                return;
              }
            }
            textarea.onKeyDown(event);
          }}
        />
        {showSuggestions && currentToken && (
          <div
            role="listbox"
            aria-label={currentToken.kind === "skill" ? "スキル候補" : "エージェント候補"}
            className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-xl border border-border bg-bg p-1 shadow-lg"
          >
            {suggestions.map((reference, index) => {
              const kind = currentToken.kind;
              const selected = index === activeSuggestion;
              return (
                <button
                  key={`${kind}-${reference.name}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${selected ? "bg-surface-2" : "hover:bg-surface-2"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSuggestion(reference, kind)}
                >
                  {kind === "skill" ? <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-text">{composerReferenceValue(kind, reference.name)}</span>
                    {reference.description && <span className="block truncate text-xs text-muted">{reference.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <div className="relative min-w-0 flex-1 overflow-x-auto">
          <div
            role="group"
            aria-label="タスク設定"
            tabIndex={0}
            className="flex min-w-max items-center gap-2 overflow-x-auto rounded-md [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <input
              ref={attachmentControl.inputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={attachmentControl.inputDisabled}
              onChange={(event) => {
                if (event.target.files) attachmentControl.onFilesSelected(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={attachmentControl.buttonDisabled}
              title={attachmentControl.buttonTitle}
              aria-label={attachmentControl.buttonTitle}
              onClick={attachmentControl.onTrigger}
              className="flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg px-2 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            {toolbar}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-md bg-gradient-to-l from-bg to-transparent sm:hidden"
          />
        </div>
        {action}
      </div>
    </>
  );

  if (form) {
    return (
      <form aria-label={form.ariaLabel} onSubmit={form.onSubmit} className={className}>
        {inner}
      </form>
    );
  }
  return <div className={className}>{inner}</div>;
}
