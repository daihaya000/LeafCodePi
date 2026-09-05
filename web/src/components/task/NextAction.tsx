"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, Sparkles } from "lucide-react";
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
  onApply: (suggestion: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [previous, setPrevious] = useState<string[]>([]);
  const [applied, setApplied] = useState<number | null>(null);
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
    setPrevious([]);
    setApplied(null);
    setState({ kind: "idle" });
  }, [invalidateKey, sessionId, taskId]);

  const generate = useCallback(async () => {
    if (!mountedRef.current || disabled) return;
    const generation = ++generationRef.current;
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

  return (
    <section className="min-w-0 w-full md:w-auto" aria-label="次の一手">
      {state.kind === "idle" && (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void generate()}>
          <Sparkles className="h-3.5 w-3.5" />
          次の指示を提案
        </Button>
      )}
      {state.kind === "loading" && (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted" aria-busy="true">
          <span role="status">次の指示を生成中…</span>
        </div>
      )}
      {state.kind === "error" && (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">{state.message}</p>
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void generate()}>
            <RefreshCw className="h-3.5 w-3.5" />
            再試行
          </Button>
        </div>
      )}
      {state.kind === "success" && (
        <div className="flex flex-col gap-2" aria-live="polite">
          {state.model && (
            <p
              className="flex min-w-0 items-center gap-1 text-xs text-muted"
              title={`生成モデル: ${directGenerationModelKey(state.model)}`}
            >
              <span className="shrink-0">生成モデル:</span>
              <span className="min-w-0 truncate font-mono">{state.model.modelID}</span>
            </p>
          )}
          {state.suggestions.map((suggestion, index) => (
            <div key={`${index}-${suggestion}`} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
              <p className="text-sm leading-6 text-text">{suggestion}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant={applied === index ? "secondary" : "primary"}
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setApplied(index);
                    onApply(suggestion);
                  }}
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  {applied === index ? "反映済み" : "入力欄に反映"}
                </Button>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void generate()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  別の提案
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
