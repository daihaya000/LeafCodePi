"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
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
  panelRef,
  onApply,
  disabled = false,
}: {
  taskId: string;
  sessionId: string;
  model?: DirectModelSelection;
  invalidateKey?: string;
  panelRef: RefObject<HTMLDivElement | null>;
  onApply: (suggestion: string) => boolean | void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [previous, setPrevious] = useState<string[]>([]);
  const [applied, setApplied] = useState<number | null>(null);
  const [contextNotice, setContextNotice] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    if (panelOpen) setContextNotice(true);
    setPrevious([]);
    setApplied(null);
    setState({ kind: "idle" });
  }, [invalidateKey, panelOpen, sessionId, taskId]);

  function closePanel(restoreFocus = true) {
    setPanelOpen(false);
    setContextNotice(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  const generate = useCallback(async () => {
    if (!mountedRef.current || disabled) return;
    const generation = ++generationRef.current;
    setContextNotice(false);
    setPanelOpen(true);
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
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "提案の生成に失敗しました。",
      });
    }
  }, [disabled, model, previous, taskId]);

  const panelContainer = panelRef.current;
  const panel = panelOpen && panelContainer ? (
    <section
      id={`${panelId}-panel`}
      aria-label="次の指示の提案"
      className="mt-2 overflow-hidden rounded-xl border border-border bg-surface-2/50"
    >
      <div className="flex min-h-11 items-center justify-between gap-2 px-3">
        <h2 className="text-xs font-medium text-text">次の指示の提案</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="提案を閉じる"
          title="提案を閉じる"
          onClick={() => closePanel()}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto border-t border-border p-3">
        {contextNotice && (
          <p role="status" className="text-xs text-muted">
            会話が更新されたため、提案を破棄しました。
          </p>
        )}
        {state.kind === "loading" && (
          <p role="status" className="text-sm text-muted">次の指示を生成中…</p>
        )}
        {state.kind === "error" && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">{state.message}</p>
            <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void generate()}>
              <RefreshCw className="h-3.5 w-3.5" />
              再試行
            </Button>
          </div>
        )}
        {state.kind === "success" && (
          <div className="flex flex-col gap-2" aria-live="polite">
            {state.suggestions.map((suggestion, index) => (
              <div key={`${index}-${suggestion}`} className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="break-words text-sm leading-6 text-text [overflow-wrap:anywhere]">{suggestion}</p>
                <Button
                  variant={applied === index ? "secondary" : "primary"}
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    const appliedResult = onApply(suggestion);
                    if (appliedResult === false) return;
                    setApplied(index);
                    closePanel(appliedResult !== true);
                  }}
                  className="mt-2 min-h-11 md:min-h-8"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  {applied === index ? "反映済み" : "入力欄に反映"}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {state.model && (
                <p className="text-xs text-muted" title={`生成モデル: ${directGenerationModelKey(state.model)}`}>
                  生成モデル: <span>{state.model.modelID}</span>
                </p>
              )}
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
        )}
      </div>
    </section>
  ) : null;

  return (
    <>
      <section className="min-w-0 w-auto shrink-0" aria-label="次の指示の提案操作">
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          busy={state.kind === "loading"}
          disabled={disabled || state.kind === "loading"}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? `${panelId}-panel` : undefined}
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
              setPanelOpen(true);
              return;
            }
            void generate();
          }}
          className="h-8 min-w-0 whitespace-nowrap px-2.5"
        >
          {state.kind !== "loading" && <Sparkles className="h-3.5 w-3.5" />}
          {state.kind === "success" ? "提案を表示" : "提案"}
        </Button>
      </section>
      {panel && panelContainer && createPortal(panel, panelContainer)}
    </>
  );
}
