"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import type { CodexBarUsage } from "@/lib/codexbar";

/** Poll while the tab is visible (~60s; server caches ~5min). */
const POLL_MS = 60_000;

export function useCodexUsage() {
  const [usage, setUsage] = useState<CodexBarUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  const refresh = useCallback(async (force?: boolean) => {
    setRefreshing(true);
    try {
      const data = await getJson<CodexBarUsage>(
        "/api/codexbar/usage",
        force ? { refresh: "1" } : undefined,
      );
      if (!mounted.current) return;
      setUsage(data);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        void refresh();
      }
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { usage, loadError, refreshing, refresh, now };
}
