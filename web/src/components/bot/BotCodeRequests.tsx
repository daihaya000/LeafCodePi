"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/client";
import type { CodeRequestState } from "@/lib/types";
import { CodeRequestCard } from "@/components/bot/CodeRequestCard";

type RequestSummary = { id: string; codeTaskId: string | null; state: CodeRequestState; prompt: string; result?: string; queuedAt?: number };
export function BotCodeRequests({ botId, requestIds }: { botId: string; requestIds: string[] }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  useEffect(() => {
    let closed = false;
    const load = async () => { try { const result = await getJson<{ requests: RequestSummary[] }>(`/api/bots/${encodeURIComponent(botId)}/code-requests`); if (!closed) setRequests(Array.isArray(result.requests) ? result.requests : []); } catch { /* Bot view remains usable */ } };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [botId]);
  const matching = requests.filter((request) => requestIds.includes(request.id));
  if (matching.length === 0) return null;
  return <section aria-label="Code依頼" className="mt-3 space-y-2"><h3 className="text-sm font-medium">Code依頼</h3>{matching.map((request) => <CodeRequestCard key={request.id} taskId={request.codeTaskId} state={request.state} prompt={request.prompt} />)}</section>;
}
