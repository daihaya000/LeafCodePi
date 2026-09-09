"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/client";
import type { CodeRequestState, TaskDetail } from "@/lib/types";
import { BotMessageMarkdown } from "@/components/bot/BotMessageList";

type RequestSummary = { id: string; codeTaskId: string | null; state: CodeRequestState; prompt: string; result?: string; queuedAt?: number };
const STATE: Record<CodeRequestState, string> = { queued: "待機中", starting: "起動準備", running: "実行中", ready: "結果を報告中", delivered: "完了", cancelled: "中断" };

function output(task: TaskDetail | null): string {
  if (!task) return "";
  for (const message of [...(task.messages ?? [])].reverse()) {
    if (message.role !== "assistant") continue;
    const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function RequestCard({ request }: { request: RequestSummary }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!request.codeTaskId) return;
    let closed = false;
    const load = async () => {
      try { const result = await getJson<{ task: TaskDetail | null }>(`/api/tasks/${encodeURIComponent(request.codeTaskId!)}`); if (!closed) setTask(result.task); } catch { /* request state remains visible */ }
    };
    void load();
    if (request.state !== "running" && request.state !== "starting") return () => { closed = true; };
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [request.codeTaskId, request.state]);
  const preview = output(task).slice(0, 4_000);
  return <article className="rounded-xl border border-border bg-surface p-3 text-sm">
    <div className="flex items-center gap-2"><span className="rounded-full bg-surface-2 px-2 py-1 text-xs text-muted">{STATE[request.state]}</span><span className="min-w-0 flex-1 truncate">{request.prompt}</span>{request.codeTaskId && <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="min-h-9 shrink-0 rounded-lg px-2 text-accent hover:bg-surface-2">{open ? "閉じる" : "プレビュー"}</button>} </div>
    {open && <div role="region" aria-label="Codeプレビュー" className="mt-3 border-t border-border pt-3">{preview ? <div tabIndex={0} aria-label="Codeの出力" className="max-h-96 overflow-auto rounded-lg bg-bg p-3 leading-relaxed [overflow-wrap:anywhere]"><BotMessageMarkdown text={preview} /></div> : <p className="text-muted">Codeの出力を待っています…</p>}</div>}
  </article>;
}

export function BotCodeRequests({ botId, anchored = true }: { botId: string; anchored?: boolean }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  useEffect(() => {
    let closed = false;
    const load = async () => { try { const result = await getJson<{ requests: RequestSummary[] }>(`/api/bots/${encodeURIComponent(botId)}/code-requests`); if (!closed) setRequests(Array.isArray(result.requests) ? result.requests : []); } catch { /* Bot view remains usable */ } };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [botId]);
  if (requests.length === 0 || !anchored) return null;
  return <section aria-label="Code依頼" className="mt-3 space-y-2"><h3 className="text-sm font-medium">Code依頼</h3>{requests.map((request) => <RequestCard key={request.id} request={request} />)}</section>;
}
