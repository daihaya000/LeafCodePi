"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";
import { sendJson } from "@/lib/client";
import {
  directGenerationModelKey,
  parseDirectGenerationModelResponse,
  parseSuggestions,
  PREVIOUS_SUGGESTIONS_MAX_COUNT,
  type DirectGenerationModel,
} from "@/lib/direct-generation-text";
import type { ModelOption } from "@/lib/types";

type DirectModelSelection = Pick<
  ModelOption,
  "providerID" | "modelID" | "accountId"
>;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; suggestions: string[]; model?: DirectGenerationModel }
  | { kind: "error"; message: string };

export function NextAction({
  taskId,
  sessionId,
  model,
  invalidateKey,
  onApply,
  disabled = false,
}: {
  taskId: string;
  sessionId: string;
  model?: DirectModelSelection;
  invalidateKey?: string;
  onApply: (suggestion: string) => boolean | void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [previous, setPrevious] = useState<string[]>([]);
  const [applied, setApplied] = useState<number | null>(null);
  const [contextNotice, setContextNotice] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const resultId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const preserveFocusRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const contextRef = useRef({ taskId, sessionId, invalidateKey });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const previousContext = contextRef.current;
    if (
      previousContext.taskId === taskId &&
      previousContext.sessionId === sessionId &&
      previousContext.invalidateKey === invalidateKey
    ) {
      return;
    }
    contextRef.current = { taskId, sessionId, invalidateKey };
    generationRef.current += 1;
    if (resultOpen) setContextNotice(true);
    setPrevious([]);
    setApplied(null);
    preserveFocusRef.current = false;
    setResultOpen(false);
    setState({ kind: "idle" });
  }, [invalidateKey, resultOpen, sessionId, taskId]);

  useEffect(() => {
    if (!resultOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const trigger = triggerRef.current;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setResultOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      if (!preserveFocusRef.current && previousFocus && document.contains(previousFocus)) {
        trigger?.focus();
      }
      preserveFocusRef.current = false;
    };
  }, [resultOpen]);

  function closeResult(preserveFocus = false) {
    preserveFocusRef.current = preserveFocus;
    setResultOpen(false);
  }

  const generate = useCallback(async () => {
    if (!mountedRef.current || disabled) return;
    const generation = ++generationRef.current;
    preserveFocusRef.current = false;
    setContextNotice(false);
    setResultOpen(false);
    setApplied(null);
    setState({ kind: "loading" });
    try {
      const body: Record<string, unknown> = {};
      if (model?.providerID && model.modelID) {
        body.model = {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(model.accountId ? { accountId: model.accountId } : {}),
        };
      }
      if (previous.length > 0) body.previousSuggestions = previous;
      const response = await sendJson<unknown>(`/api/tasks/${taskId}/next-action`, body);
      const suggestions = parseSuggestions(response);
      const generatedModel = parseDirectGenerationModelResponse(response);
      if (suggestions.length === 0) throw new Error("提案の応答が空です");
      if (!mountedRef.current || generation !== generationRef.current) return;
      setPrevious((current) => {
        const next = [...current, ...suggestions.filter((item) => !current.includes(item))];
        return next.slice(-PREVIOUS_SUGGESTIONS_MAX_COUNT);
      });
      setState({ kind: "success", suggestions, model: generatedModel });
      setResultOpen(true);
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "提案の生成に失敗しました。",
      });
    }
  }, [disabled, model, previous, taskId]);

  return (
    <>
      <section className="min-w-0 w-full md:w-auto" aria-label="次の指示の提案">
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          busy={state.kind === "loading"}
          disabled={disabled || state.kind === "loading"}
          aria-haspopup={state.kind === "success" ? "dialog" : undefined}
          aria-expanded={state.kind === "success" ? resultOpen : undefined}
          aria-controls={state.kind === "success" ? `${resultId}-dialog` : undefined}
          aria-label={
            state.kind === "loading"
              ? "次の指示を生成中…"
              : state.kind === "success"
                ? "提案を表示"
                : "次の指示を提案"
          }
          onClick={() => {
            setContextNotice(false);
            if (state.kind === "success") {
              setResultOpen(true);
              return;
            }
            void generate();
          }}
          className="h-11 min-w-0 px-3 md:h-8 md:px-2.5"
        >
          {state.kind !== "loading" && <Sparkles className="h-3.5 w-3.5" />}
          {state.kind === "success" ? "提案を表示" : "次の指示を提案"}
        </Button>
        {state.kind === "loading" && (
          <span role="status" aria-live="polite" className="sr-only">
            次の指示を生成中…
          </span>
        )}
        {contextNotice && (
          <p role="status" className="mt-2 max-w-sm text-xs text-muted">
            会話が更新されたため、提案を閉じました。
          </p>
        )}
        {state.kind === "error" && (
          <div className="mt-2 flex max-w-sm flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
            <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">{state.message}</p>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => void generate()}
              className="min-h-11 md:min-h-8"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              再試行
            </Button>
          </div>
        )}
      </section>
      {resultOpen &&
        state.kind === "success" &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeResult();
            }}
          >
            <div
              ref={dialogRef}
              id={`${resultId}-dialog`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${resultId}-title`}
              className="flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
            >
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 id={`${resultId}-title`} className="min-w-0 text-base font-semibold text-text">
                  次の指示の提案
                </h2>
                <Button
                  ref={closeButtonRef}
                  variant="ghost"
                  size="icon"
                  aria-label="提案を閉じる"
                  title="提案を閉じる"
                  onClick={() => closeResult()}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-h-0 overflow-y-auto p-4">
                <div className="flex flex-col gap-3" aria-live="polite">
                  {state.suggestions.map((suggestion, index) => (
                    <div key={`${index}-${suggestion}`} className="rounded-xl border border-border bg-surface-2 p-3">
                      <p className="break-words text-sm leading-6 text-text [overflow-wrap:anywhere]">{suggestion}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          variant={applied === index ? "secondary" : "primary"}
                          size="sm"
                          disabled={disabled}
                          onClick={() => {
                            const appliedResult = onApply(suggestion);
                            if (appliedResult === false) return;
                            setApplied(index);
                            closeResult(appliedResult === true);
                          }}
                          className="min-h-11 md:min-h-8"
                        >
                          <ArrowDownToLine className="h-3.5 w-3.5" />
                          {applied === index ? "反映済み" : "入力欄に反映"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={disabled}
                          onClick={() => void generate()}
                          className="min-h-11 md:min-h-8"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          別の提案
                        </Button>
                      </div>
                    </div>
                  ))}
                  {state.model && (
                    <p
                      className="text-xs text-muted"
                      title={`生成モデル: ${directGenerationModelKey(state.model)}`}
                    >
                      生成モデル: <span className="font-mono">{state.model.modelID}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
