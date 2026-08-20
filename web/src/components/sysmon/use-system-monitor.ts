"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import type { SystemUsage } from "@/lib/sysmon";

/** Expanded widget poll. Server caches ~3s; keep client slower to cut churn. */
export const SYSMON_POLL_ACTIVE_MS = 15_000;
/** Collapsed summary only — avoid nvidia-smi / PowerShell while chatting. */
export const SYSMON_POLL_COLLAPSED_MS = 60_000;

export function useSystemMonitor(options?: {
  /** When false, keep last snapshot and stop polling (until re-enabled). */
  enabled?: boolean;
  intervalMs?: number;
}) {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs ?? SYSMON_POLL_ACTIVE_MS;
  const [usage, setUsage] = useState<SystemUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    if (inFlight.current) return inFlight.current;
    const quiet = opts?.quiet ?? false;

    const run = (async () => {
      if (!quiet) setRefreshing(true);
      try {
        const data = await getJson<SystemUsage>("/api/sysmon/usage");
        if (!mounted.current) return;
        setUsage(data);
        setLoadError(null);
      } catch (err) {
        if (!mounted.current) return;
        setLoadError(err instanceof Error ? err.message : "取得に失敗しました");
      } finally {
        if (mounted.current && !quiet) setRefreshing(false);
        inFlight.current = null;
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

  // One quiet fetch on mount so collapsed summary has data.
  useEffect(() => {
    void refresh({ quiet: true });
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ quiet: true });
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, refresh]);

  return {
    usage,
    loadError,
    refreshing,
    refresh: () => refresh({ quiet: false }),
  };
}
