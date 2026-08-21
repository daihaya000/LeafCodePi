"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import type { SubagentRunDto } from "@/lib/types";

const POLL_MS = 2000;

/** ツール入力から子エージェント名を集める（single / parallel / chain）。 */
export function subagentAgentNames(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) names.add(value.trim());
  };
  add(input.agent);
  add(input.subagent_type);
  for (const key of ["tasks", "chain", "agents"]) {
    const rows = input[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row === "string") add(row);
      else if (row && typeof row === "object") {
        add((row as { agent?: unknown }).agent);
        add((row as { subagent_type?: unknown }).subagent_type);
      }
    }
  }
  return [...names];
}

/** runIds が分かればそれを優先、無ければ agent 名、どちらも無ければ時間窓で絞る。 */
export function matchSubagentRuns(
  runs: readonly SubagentRunDto[],
  runIds: readonly string[],
  agentNames: readonly string[],
): SubagentRunDto[] {
  if (runIds.length > 0) {
    const wanted = new Set(runIds);
    const exact = runs.filter((run) => wanted.has(run.runId));
    if (exact.length > 0) return exact;
  }
  if (agentNames.length > 0) {
    const wanted = new Set(agentNames.map((name) => name.toLowerCase()));
    const byAgent = runs.filter((run) => wanted.has(run.agent.toLowerCase()));
    if (byAgent.length > 0) return byAgent;
  }
  return [...runs];
}

/**
 * サブエージェント子実行を BFF からポーリングする。
 * 実行中は 2 秒間隔、終了後は 1 回だけ取得する（本家 LeafCode の
 * NestedAgentPanel と同じ間隔）。
 */
export function useSubagentRuns(input: {
  taskId?: string;
  enabled: boolean;
  live: boolean;
  sinceMs?: number;
  runIds?: readonly string[];
  agentNames?: readonly string[];
}): { runs: SubagentRunDto[]; error: string | null; loading: boolean } {
  const [runs, setRuns] = useState<SubagentRunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  const runIdsKey = (input.runIds ?? []).join(",");
  const agentKey = (input.agentNames ?? []).join(",");
  const { taskId, enabled, live, sinceMs } = input;

  useEffect(() => {
    if (!enabled || !taskId) return;
    let cancelled = false;
    const query = sinceMs !== undefined ? `?since=${Math.floor(sinceMs)}` : "";

    const load = async () => {
      if (!loadedRef.current) setLoading(true);
      try {
        const result = await getJson<{ runs: SubagentRunDto[] }>(
          `/api/tasks/${taskId}/subagents${query}`,
        );
        if (cancelled) return;
        loadedRef.current = true;
        setRuns(result.runs ?? []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // 取得できない間は直近の内容を残す（本家と同じ sticky 挙動）。
        setError(err instanceof Error ? err.message : "サブエージェントの進捗を取得できませんでした");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    if (!live) return () => {
      cancelled = true;
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskId, enabled, live, sinceMs]);

  const matched = useMemo(
    () =>
      matchSubagentRuns(
        runs,
        runIdsKey ? runIdsKey.split(",") : [],
        agentKey ? agentKey.split(",") : [],
      ),
    [runs, runIdsKey, agentKey],
  );

  return { runs: matched, error, loading };
}
