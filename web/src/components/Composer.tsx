"use client";

import { useLayoutEffect } from "react";
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
} from "react";
import { Paperclip, X } from "lucide-react";

export type ComposerAttachment = {
  uri: string;
  mime: string;
  name?: string;
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
    onClick?: MouseEventHandler<HTMLTextAreaElement>;
    onKeyUp?: KeyboardEventHandler<HTMLTextAreaElement>;
    onSelect?: ReactEventHandler<HTMLTextAreaElement>;
    onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
    onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
    onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
    onBlur?: FocusEventHandler<HTMLTextAreaElement>;
    onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  };
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
  attachmentControl,
  toolbar,
  action,
}: ComposerProps) {
  useLayoutEffect(() => {
    const element = textarea.ref.current;
    if (!element) return;

    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [textarea.ref, textarea.rows, textarea.value]);

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
      <textarea
        ref={textarea.ref}
        value={textarea.value}
        rows={textarea.rows}
        aria-label={textarea.ariaLabel}
        disabled={textarea.disabled}
        readOnly={textarea.readOnly}
        placeholder={textarea.placeholder}
        className={`${textarea.className} max-h-60 overflow-y-auto focus-visible:outline-none`}
        style={textarea.style}
        onChange={textarea.onChange}
        onClick={textarea.onClick}
        onKeyUp={textarea.onKeyUp}
        onSelect={textarea.onSelect}
        onPaste={textarea.onPaste}
        onCompositionStart={textarea.onCompositionStart}
        onCompositionEnd={textarea.onCompositionEnd}
        onBlur={textarea.onBlur}
        onKeyDown={textarea.onKeyDown}
      />
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
