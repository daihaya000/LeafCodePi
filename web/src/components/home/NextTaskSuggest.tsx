"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  | { kind: "success"; suggestion: string; model?: DirectGenerationModel }
  | { kind: "error"; message: string };

export function NextTaskSuggest({
  projectId,
  model,
  disabled = false,
  onApply,
}: {
  projectId: string;
  model?: DirectModelSelection;
  disabled?: boolean;
  onApply: (suggestion: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [previous, setPrevious] = useState<string[]>([]);
  const [applied, setApplied] = useState(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const projectRef = useRef(projectId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    generationRef.current += 1;
    setPrevious([]);
    setApplied(false);
    setState({ kind: "idle" });
  }, [projectId]);

  const generate = useCallback(async () => {
    if (!mountedRef.current || !projectId || disabled) return;
    const generation = ++generationRef.current;
    setApplied(false);
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
      const response = await sendJson<unknown>(
        `/api/projects/${encodeURIComponent(projectId)}/next-task`,
        body,
        "POST",
        { timeoutMs: 180_000 },
      );
      const suggestion = parseSuggestions(response)[0];
      const generatedModel = parseDirectGenerationModelResponse(response);
      if (!suggestion) throw new Error("提案の応答が空です");
      if (!mountedRef.current || generation !== generationRef.current) return;
      setPrevious((current) => [...current, suggestion].filter((item, index, all) => all.indexOf(item) === index).slice(-PREVIOUS_SUGGESTIONS_MAX_COUNT));
      setState({ kind: "success", suggestion, model: generatedModel });
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "提案の生成に失敗しました。",
      });
    }
  }, [disabled, model, previous, projectId]);

  if (!projectId) return null;
  return (
    <section className="mx-auto mt-3 max-w-5xl" aria-label="次のタスクを提案">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" busy={state.kind === "loading"} disabled={disabled || state.kind === "loading"} onClick={() => void generate()}>
          {state.kind !== "loading" && <Sparkles className="h-3.5 w-3.5" />}
          {state.kind === "success" ? "別の提案を生成" : "次のタスクを提案"}
        </Button>
        {state.kind === "success" && (
          <Button variant="ghost" size="sm" aria-label="提案を閉じる" onClick={() => setState({ kind: "idle" })}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {state.kind === "error" && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">{state.message}</p>
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void generate()}>
            <RefreshCw className="h-3.5 w-3.5" />
            再試行
          </Button>
        </div>
      )}
      {state.kind === "success" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setApplied(true);
            onApply(state.suggestion);
          }}
          className="mt-2 flex w-full items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-sm text-text hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
          title="この提案をコンポーザーに反映"
        >
          <ArrowDownToLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block break-words">{state.suggestion}</span>
            {state.model && (
              <span
                className="mt-1 block truncate text-xs text-muted"
                title={`生成モデル: ${directGenerationModelKey(state.model)}`}
              >
                生成モデル: <span className="font-mono">{state.model.modelID}</span>
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] text-muted">{applied ? "反映済み" : "入力欄に反映"}</span>
        </button>
      )}
    </section>
  );
}
