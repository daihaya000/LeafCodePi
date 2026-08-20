"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Composer, type ComposerAttachment } from "@/components/Composer";
import { ModelSelect } from "@/components/ModelSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { PartView } from "@/components/task/PartView";
import { Button } from "@/components/ui";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import type { ModelOption, TaskDetail, UiMessage } from "@/lib/types";

export function TaskView({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const applyDetail = useCallback((detail: TaskDetail) => {
    setTask(detail);
    setMessages(detail.messages);
  }, []);

  useEffect(() => {
    let closed = false;
    const source = new EventSource(`/api/tasks/${taskId}/events`);
    source.addEventListener("snapshot", (event) => {
      if (closed) return;
      const payload = JSON.parse((event as MessageEvent).data) as {
        task?: TaskDetail;
        messages?: UiMessage[];
        isStreaming?: boolean;
        error?: string;
      };
      const snapshotTask = payload.task;
      if (snapshotTask) {
        setTask((current) => ({
          ...(current ?? snapshotTask),
          ...snapshotTask,
          messages: payload.messages ?? snapshotTask.messages,
          isStreaming: payload.isStreaming ?? snapshotTask.isStreaming,
        }));
      }
      if (payload.messages) setMessages(payload.messages);
      if (payload.error) setError(payload.error);
      notifyTasksChanged();
    });
    source.addEventListener("error", () => {
      if (!closed) setError((current) => current ?? "イベント接続に失敗しました");
    });
    void getJson<{ task: TaskDetail }>(`/api/tasks/${taskId}`).then((result) => {
      if (!closed) applyDetail(result.task);
    });
    void getJson<{ models: ModelOption[] }>("/api/models").then((result) => {
      if (!closed) setModels(result.models);
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [taskId, applyDetail]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, task?.isStreaming]);

  function addImageFiles(files: FileList) {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const uri = String(reader.result ?? "");
        setAttachments((current) => [...current, { uri, mime: file.type, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });
  }

  async function submit() {
    if ((!prompt.trim() && attachments.length === 0) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const images = attachments
        .map((attachment) => {
          const comma = attachment.uri.indexOf(",");
          if (comma < 0) return null;
          return { mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) };
        })
        .filter((item): item is { mimeType: string; data: string } => item !== null);
      await sendJson(`/api/tasks/${taskId}/prompt`, { prompt, images });
      setPrompt("");
      setAttachments([]);
      notifyTasksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  const modelValue =
    task?.providerID && task.modelID ? `${task.providerID}::${task.modelID}` : models[0]?.value ?? "";
  const working = task?.status === "working" || task?.isStreaming;

  return (
    <div className="flex h-full flex-col">
      <MobileMenuHeader />
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{task?.title ?? "読み込み中…"}</h1>
          <p className="truncate text-[11px] text-muted">{task?.directory}</p>
        </div>
        {task && <StatusBadge status={working ? "working" : task.status} />}
        {working && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => void sendJson(`/api/tasks/${taskId}/abort`, {})}
          >
            <Square className="h-3.5 w-3.5" />
            停止
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {messages.map((message) => (
            <PartView key={message.id} message={message} />
          ))}
          {messages.length === 0 && (
            <p className="py-12 text-center text-sm text-muted">メッセージはまだありません</p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-3xl rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Composer
          form={{
            ariaLabel: "フォローアップ",
            onSubmit: (event) => {
              event.preventDefault();
              void submit();
            },
          }}
          className="relative mx-auto max-w-3xl rounded-2xl border border-border bg-bg px-3 py-2 shadow-sm focus-within:border-border-strong focus-within:ring-2 focus-within:ring-primary/20"
          attachments={attachments}
          onRemoveAttachment={(index) =>
            setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
          }
          textarea={{
            ref: textareaRef,
            value: prompt,
            rows: 1,
            ariaLabel: "フォローアップ",
            onChange: (event) => setPrompt(event.target.value),
            onCompositionStart: () => {
              composingRef.current = true;
            },
            onCompositionEnd: () => {
              composingRef.current = false;
            },
            onKeyDown: (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composingRef.current) {
                event.preventDefault();
                void submit();
              }
            },
            placeholder: working ? "実行中です。送信するとフォローアップになります…" : "続きを指示…（Ctrl+Enter）",
            className: "w-full resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-faint",
          }}
          attachmentControl={{
            inputRef: fileInputRef,
            buttonTitle: "画像を添付",
            onFilesSelected: addImageFiles,
            onTrigger: () => fileInputRef.current?.click(),
          }}
          toolbar={
            <ModelSelect
              value={modelValue}
              options={models}
              disabled={working}
              onChange={(value) => {
                void sendJson(`/api/tasks/${taskId}/model`, { model: value });
              }}
              className="max-w-[12rem]"
            />
          }
          action={
            <Button
              variant="primary"
              size="icon"
              type="submit"
              aria-label="送信"
              busy={submitting}
              disabled={!prompt.trim() && attachments.length === 0}
            >
              {!submitting && <ArrowUp className="h-4.5 w-4.5" />}
            </Button>
          }
        />
      </div>
    </div>
  );
}
