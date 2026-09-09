"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import type { CodeRequestGoalLoopReport, CodeRequestState } from "@/lib/types";
import { CodeRequestCard } from "@/components/bot/CodeRequestCard";

type RequestSummary = { id: string; codeTaskId: string | null; state: CodeRequestState; prompt: string; result?: string; outcome?: string; goalLoop?: CodeRequestGoalLoopReport; queuedAt?: number };

type RequestCacheEntry = { requests: RequestSummary[]; fetchedAt: number; subscribers: number; pending?: Promise<RequestSummary[]> };
const REQUEST_CACHE_TTL_MS = 500;
const requestCache = new Map<string, RequestCacheEntry>();

function fetchCodeRequests(botId: string): Promise<RequestSummary[]> {
  const cached = requestCache.get(botId);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() - cached.fetchedAt < REQUEST_CACHE_TTL_MS) return Promise.resolve(cached.requests);
  const entry: RequestCacheEntry = cached ?? { requests: [], fetchedAt: 0, subscribers: 0 };
  const request = getJson<{ requests: RequestSummary[] }>(`/api/bots/${encodeURIComponent(botId)}/code-requests`).then((result) => {
    entry.requests = Array.isArray(result.requests) ? result.requests : [];
    entry.fetchedAt = Date.now();
    entry.pending = undefined;
    return entry.requests;
  }, (reason) => {
    entry.pending = undefined;
    throw reason;
  });
  entry.pending = request;
  requestCache.set(botId, entry);
  return request;
}

function subscribeCodeRequests(botId: string): () => void {
  const entry = requestCache.get(botId) ?? { requests: [], fetchedAt: 0, subscribers: 0 };
  entry.subscribers += 1;
  requestCache.set(botId, entry);
  return () => {
    if (entry.subscribers > 0) entry.subscribers -= 1;
    if (entry.subscribers === 0 && requestCache.get(botId) === entry) requestCache.delete(botId);
  };
}

export function BotCodeRequests({ botId, requestIds, active = true }: { botId: string; requestIds: string[]; active?: boolean }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await fetchCodeRequests(botId);
      setRequests(next);
      return next;
    } catch { /* Bot view remains usable */ return null; }
  }, [botId]);
  const requestIdsKey = requestIds.join("\0");
  const pollingRequestIds = useMemo(() => new Set(requestIdsKey ? requestIdsKey.split("\0") : []), [requestIdsKey]);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeCodeRequests(botId);
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (closed) return;
      const next = await load();
      if (closed) return;
      const matching = next?.filter((request) => pollingRequestIds.has(request.id)) ?? [];
      const terminal = matching.length > 0 && matching.every((request) => request.state === "delivered" || request.state === "cancelled");
      if (!terminal) timer = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => { closed = true; if (timer !== undefined) window.clearTimeout(timer); unsubscribe(); };
  }, [active, botId, load, pollingRequestIds]);
  const stop = async (requestId: string) => {
    if (stopping) return;
    setStopping(requestId); setError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(botId)}/code-requests`, { action: "abort", requestId });
      const cached = requestCache.get(botId);
      if (cached) cached.fetchedAt = 0;
      await load();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Codeの停止に失敗しました"); }
    finally { setStopping(null); }
  };
  if (!active) return null;
  const matching = requests.filter((request) => requestIds.includes(request.id));
  if (matching.length === 0) return null;
  return <section aria-label="Code依頼" className="mt-3 space-y-2"><h3 className="text-sm font-medium">Code依頼</h3>{matching.map((request) => <CodeRequestCard key={request.id} taskId={request.codeTaskId} state={request.state} prompt={request.prompt} outcome={request.outcome} goalLoop={request.goalLoop} stopping={stopping === request.id} onStop={() => void stop(request.id)} />)}{error && <p role="alert" className="text-xs text-danger">{error}</p>}</section>;
}
