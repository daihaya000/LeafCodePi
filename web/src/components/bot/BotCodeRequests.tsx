"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import type { CodeRequestGoalLoopReport, CodeRequestState } from "@/lib/types";
import { CodeRequestCard } from "@/components/bot/CodeRequestCard";

type RequestSummary = { id: string; codeTaskId: string | null; state: CodeRequestState; prompt: string; result?: string; outcome?: string; goalLoop?: CodeRequestGoalLoopReport; queuedAt?: number };
export function BotCodeRequests({ botId, requestIds, active = true }: { botId: string; requestIds: string[]; active?: boolean }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const result = await getJson<{ requests: RequestSummary[] }>(`/api/bots/${encodeURIComponent(botId)}/code-requests`); setRequests(Array.isArray(result.requests) ? result.requests : []); } catch { /* Bot view remains usable */ }
  }, [botId]);
  useEffect(() => {
    if (!active) return;
    let closed = false;
    const poll = () => { if (!closed) void load(); };
    poll();
    const timer = window.setInterval(poll, 2_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [active, load]);
  const stop = async (requestId: string) => {
    if (stopping) return;
    setStopping(requestId); setError(null);
    try { await sendJson(`/api/bots/${encodeURIComponent(botId)}/code-requests`, { action: "abort", requestId }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Codeの停止に失敗しました"); }
    finally { setStopping(null); }
  };
  if (!active) return null;
  const matching = requests.filter((request) => requestIds.includes(request.id));
  if (matching.length === 0) return null;
  return <section aria-label="Code依頼" className="mt-3 space-y-2"><h3 className="text-sm font-medium">Code依頼</h3>{matching.map((request) => <CodeRequestCard key={request.id} taskId={request.codeTaskId} state={request.state} prompt={request.prompt} outcome={request.outcome} goalLoop={request.goalLoop} stopping={stopping === request.id} onStop={() => void stop(request.id)} />)}{error && <p role="alert" className="text-xs text-danger">{error}</p>}</section>;
}
