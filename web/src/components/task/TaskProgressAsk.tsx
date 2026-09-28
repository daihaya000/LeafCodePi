"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, MessageCircle, RefreshCw, X } from "lucide-react";
import { COMPOSER_ACTION_BUTTON_CLASS } from "@/components/Composer";
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
  TASK_PROGRESS_CLIENT_TIMEOUT_MS,
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
  /** 質問を送った時点の会話の版。 */
  revision?: string;
};

type RequestState =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "error"; question: string; message: string };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseProgressAnswer(
  value: unknown,
  askedQuestion: string,
  revision: string | undefined,
): ProgressAnswer | null {
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
    revision,
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
  revision,
  panelRef,
  triggerOpacity = 1,
}: {
  taskId: string;
  sessionId: string;
  model?: DirectModelSelection;
  triggerOpacity?: number;
  /** 会話の版（最新メッセージ・パーツ数・実行状態）。質問後に変わったら回答を古いものとして扱う。 */
  revision?: string;
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
  const abortRef = useRef<AbortController | null>(null);
  const loading = request.kind === "loading";
  const stale = result !== null && revision !== undefined && result.revision !== revision;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      // 画面を離れたら生成も止める（サーバーはリクエストの切断で生成を中止する）。
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = contextRef.current;
    if (previous.taskId === taskId && previous.sessionId === sessionId) return;
    contextRef.current = { taskId, sessionId };
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
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
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
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
          timeoutMs: TASK_PROGRESS_CLIENT_TIMEOUT_MS,
          signal: controller.signal,
        });
        const answer = parseProgressAnswer(response, question, revision);
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
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [model, revision, taskId],
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
                  {stale && " ・その後に作業が進んでいます"}
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
          enterKeyHint="send"
          autoComplete="off"
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
      <section className="shrink-0" aria-label="進捗の確認操作">
        <button
          ref={triggerRef}
          type="button"
          aria-busy={loading || undefined}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? `${panelId}-panel` : undefined}
          aria-label={
            loading
              ? "進捗を確認中…"
              : request.kind === "error" || (result && !stale)
                ? "進捗の確認を表示"
                : "進捗を確認"
          }
          title="エージェントを止めずに生成モデルへ進捗を質問"
          onClick={() => {
            if (panelOpen) {
              closePanel(false);
              return;
            }
            // 回答後に作業が進んでいれば、古い回答を開き直さずに最新で確認する。
            if (request.kind !== "idle" || (result && !stale)) {
              setPanelOpen(true);
              return;
            }
            void ask("");
          }}
          className={cx(
            COMPOSER_ACTION_BUTTON_CLASS,
            "!h-10 !w-10 border border-border bg-bg text-muted hover:bg-surface-2 hover:text-text",
          )}
          style={{ opacity: triggerOpacity }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </section>
      {panel && panelContainer && createPortal(panel, panelContainer)}
    </>
  );
}
