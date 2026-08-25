"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import type { CodexBarUsage } from "@/lib/codexbar";

/** Match CodexBarWin default RefreshMinutes (5). Server also caches ~5 min. */
export const CODEX_POLL_MS = 5 * 60 * 1000;
/** Skip visibility refetch if we already have data this fresh. */
const CLIENT_STALE_MS = 4 * 60 * 1000;
/** Tick for "resets in" / timeAgo without refetching providers. */
const CLOCK_MS = 60_000;

export function useCodexUsage(options?: {
  /** When false, keep last snapshot and stop polling. */
  enabled?: boolean;
}) {
  const enabled = options?.enabled ?? true;
  const [usage, setUsage] = useState<CodexBarUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const lastFetchAt = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (opts?: { force?: boolean; quiet?: boolean }) => {
    const force = opts?.force ?? false;
    const quiet = opts?.quiet ?? false;
    if (inFlight.current && !force) return inFlight.current;

    let run: Promise<void> | null = null;
    run = (async () => {
      if (!quiet) setRefreshing(true);
      try {
        const data = await getJson<CodexBarUsage>(
          "/api/codexbar/usage",
          force ? { refresh: "1" } : undefined,
        );
        if (!mounted.current) return;
        setUsage(data);
        setLoadError(null);
        lastFetchAt.current = Date.now();
        setNow(Date.now());
      } catch (err) {
        if (!mounted.current) return;
        setLoadError(err instanceof Error ? err.message : "取得に失敗しました");
      } finally {
        if (mounted.current && !quiet) setRefreshing(false);
        if (run !== null && inFlight.current === run) inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh({ quiet: true });
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;

    // Expanding after being collapsed: polling was paused, so refetch when
    // the snapshot is already older than CLIENT_STALE_MS (same contract as
    // the visibility handler). Coalesces with the mount fetch via inFlight.
    if (Date.now() - lastFetchAt.current >= CLIENT_STALE_MS) {
      void refresh({ quiet: true });
    }

    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refresh({ quiet: true });
    }, CODEX_POLL_MS);

    const clock = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, CLOCK_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      const age = Date.now() - lastFetchAt.current;
      if (age < CLIENT_STALE_MS) return;
      void refresh({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  return {
    usage,
    loadError,
    refreshing,
    refresh: (force?: boolean) => refresh({ force, quiet: false }),
    now,
  };
}
