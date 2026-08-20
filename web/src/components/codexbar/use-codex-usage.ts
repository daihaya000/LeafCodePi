"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import type { CodexBarUsage } from "@/lib/codexbar";

/** Match CodexBarWin default RefreshMinutes (5). Server also caches ~5 min. */
const POLL_MS = 5 * 60 * 1000;
/** Skip visibility refetch if we already have data this fresh. */
const CLIENT_STALE_MS = 4 * 60 * 1000;

export function useCodexUsage() {
  const [usage, setUsage] = useState<CodexBarUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const lastFetchAt = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (force?: boolean) => {
    if (inFlight.current && !force) return inFlight.current;

    const run = (async () => {
      setRefreshing(true);
      try {
        const data = await getJson<CodexBarUsage>(
          "/api/codexbar/usage",
          force ? { refresh: "1" } : undefined,
        );
        if (!mounted.current) return;
        setUsage(data);
        setLoadError(null);
        lastFetchAt.current = Date.now();
      } catch (err) {
        if (!mounted.current) return;
        setLoadError(err instanceof Error ? err.message : "取得に失敗しました");
      } finally {
        if (mounted.current) setRefreshing(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      void refresh();
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      const age = Date.now() - lastFetchAt.current;
      if (age < CLIENT_STALE_MS) return;
      void refresh();
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
