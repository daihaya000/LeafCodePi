"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Activity, Loader2, RefreshCw, X } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { sendJson } from "@/lib/client";
import { isImeComposingEvent } from "@/lib/composer-ime";
import {
  directGenerationModelKey,
  parseDirectGenerationModelResponse,
  type DirectGenerationModel,
} from "@/lib/direct-generation-text";
import {
  DEFAULT_TASK_PROGRESS_QUESTION,
  TASK_PROGRESS_QUESTION_MAX_CHARS,
} from "@/lib/task-progress";
import type { ModelOption } from "@/lib/types";

type DirectModelSelection = Pick<ModelOption, "providerID" | "modelID" | "accountId">;

type ProgressAnswer = {
  question: string;
  answer: string;
  model?: DirectGenerationModel;
  snapshotAt: number;
  working: boolean;
};

type RequestState =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "error"; question: string; message: string };

/** 回答生成は長めの作業記録を読むため、直接生成のタイムアウト（90秒）より少し長く待つ。 */
const REQUEST_TIMEOUT_MS = 100_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseProgressAnswer(value: unknown, askedQuestion: string): ProgressAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (!answer) return null;
  return {
    answer,
    question:
      typeof record.question === "string" && record.question.trim()
        ? record.question.trim()
        : askedQuestion || DEFAULT_TASK_PROGRESS_QUESTION,
    model: parseDirectGenerationModelResponse(value),
    snapshotAt:
      typeof record.snapshotAt === "number" && Number.isFinite(record.snapshotAt)
        ? record.snapshotAt
        : Date.now(),
    working: record.working === true,
  };
}

/**
 * 実行中のエージェントを止めずに、生成モデルへ現在の進捗・要約を質問する。
 * 質問と回答はこの画面だけに表示し、エージェントの会話には送らない。
 */
export function TaskProgressAsk({
  taskId,
  sessionId,
  model,
  panelRef,
}: {
  taskId: string;
  sessionId: string;
  model?: DirectModelSelection;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const [request, setRequest] = useState<RequestState>({ kind: "idle" });
  const [result, setResult] = useState<ProgressAnswer | null>(null);
  const [draft, setDraft] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const contextRef = useRef({ taskId, sessionId });
  const loading = request.kind === "loading";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const previous = contextRef.current;
    if (previous.taskId === taskId && previous.sessionId === sessionId) return;
    contextRef.current = { taskId, sessionId };
    generationRef.current += 1;
    setRequest({ kind: "idle" });
    setResult(null);
    setDraft("");
    setPanelOpen(false);
  }, [sessionId, taskId]);

  function closePanel(restoreFocus = true) {
    setPanelOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  const ask = useCallback(
    async (rawQuestion: string) => {
      if (!mountedRef.current) return;
      const question = rawQuestion.trim();
      const generation = ++generationRef.current;
      setPanelOpen(true);
      setRequest({ kind: "loading", question });
      try {
        const body: Record<string, unknown> = {};
        if (question) body.question = question;
        if (model?.providerID && model.modelID) {
          body.model = {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(model.accountId ? { accountId: model.accountId } : {}),
          };
        }
        const response = await sendJson<unknown>(`/api/tasks/${taskId}/progress`, body, "POST", {
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        const answer = parseProgressAnswer(response, question);
        if (!answer) throw new Error("進捗の回答が空です");
        if (!mountedRef.current || generation !== generationRef.current) return;
        setResult(answer);
        setRequest({ kind: "idle" });
        setDraft((current) => (current.trim() === question ? "" : current));
      } catch (error) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setRequest({
          kind: "error",
          question,
          message: error instanceof Error ? error.message : "進捗の確認に失敗しました。",
        });
      }
    },
    [model, taskId],
  );

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || isImeComposingEvent(event)) return;
    event.preventDefault();
    if (!loading) void ask(draft);
  }

  const panelContainer = panelRef.current;
  const panel = panelOpen && panelContainer ? (
    <section
      id={`${panelId}-panel`}
      aria-label="進捗の確認"
      className="mt-2 overflow-hidden rounded-xl border border-border bg-surface-2/50"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isImeComposingEvent(event)) {
          event.preventDefault();
          closePanel();
        }
      }}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 px-3">
        <div className="min-w-0 py-1.5">
          <h2 className="text-xs font-medium text-text">進捗の確認</h2>
          <p className="text-xs text-muted">
            生成モデルが作業記録を読んで答えます。エージェントには送信されず、作業も止まりません。
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="進捗の確認を閉じる"
          title="閉じる"
          onClick={() => closePanel()}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {(request.kind !== "idle" || result) && (
        <div className="max-h-[min(18rem,40dvh)] overflow-y-auto border-t border-border p-3">
          {request.kind === "loading" && (
            <p role="status" className="text-sm text-muted">
              生成モデルに確認中…
            </p>
          )}
          {request.kind === "error" && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">
                {request.message}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void ask(request.question)}
                className="min-h-11 md:min-h-8"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                再試行
              </Button>
            </div>
          )}
          {result && (
            <div
              aria-live="polite"
              className={cx(request.kind !== "idle" && "mt-3", loading && "opacity-60")}
            >
              <p className="break-words text-xs text-muted [overflow-wrap:anywhere]">
                質問: {result.question}
              </p>
              <div className="md mt-1 break-words text-sm [overflow-wrap:anywhere]">
                <Markdown remarkPlugins={[remarkGfm]}>{result.answer}</Markdown>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-words text-xs text-muted">
                  {formatClock(result.snapshotAt)} 時点{result.working ? "（実行中）" : ""}
                  {result.model && (
                    <>
                      {" ・ "}
                      <span title={`生成モデル: ${directGenerationModelKey(result.model)}`}>
                        生成モデル: {result.model.modelID}
                      </span>
                    </>
                  )}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading}
                  onClick={() => void ask(result.question)}
                  className="min-h-11 md:min-h-8"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  最新で再確認
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border p-2">
        <input
          type="text"
          value={draft}
          maxLength={TASK_PROGRESS_QUESTION_MAX_CHARS}
          aria-label="進捗についての質問"
          placeholder="質問を入力（空欄で進捗を要約）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleInputKeyDown}
          className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-base text-text outline-none placeholder:text-faint focus-visible:border-accent md:h-8 md:text-sm"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={loading}
          onClick={() => void ask(draft)}
          className="min-h-11 md:min-h-8"
        >
          質問
        </Button>
      </div>
    </section>
  ) : null;

  return (
    <>
      <section className="min-w-0 w-auto shrink-0" aria-label="進捗の確認操作">
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          aria-busy={loading || undefined}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? `${panelId}-panel` : undefined}
          aria-label={
            loading
              ? "進捗を確認中…"
              : result || request.kind === "error"
                ? "進捗の確認を表示"
                : "進捗を確認"
          }
          title="エージェントを止めずに生成モデルへ進捗を質問"
          onClick={() => {
            if (panelOpen) {
              closePanel(false);
              return;
            }
            if (result || request.kind !== "idle") {
              setPanelOpen(true);
              return;
            }
            void ask("");
          }}
          className="h-8 min-w-0 whitespace-nowrap px-2.5"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          進捗
        </Button>
      </section>
      {panel && panelContainer && createPortal(panel, panelContainer)}
    </>
  );
}
