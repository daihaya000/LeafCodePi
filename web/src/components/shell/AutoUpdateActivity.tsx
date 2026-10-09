"use client";

import { useEffect } from "react";

/** Report actual input, not SSE/poll traffic: an open but unattended tab is idle. */
export function AutoUpdateActivity() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSent = -Infinity;
    let pending = false;
    let stopped = false;
    const send = () => {
      timer = undefined;
      if (stopped || !pending) return;
      pending = false;
      lastSent = Date.now();
      void fetch("/api/host/activity", {
        method: "POST", cache: "no-store", keepalive: true, signal: AbortSignal.timeout(5000),
      }).then((response) => {
        if (!response.ok) throw new Error("Activity report failed");
      }).catch(() => {
        // Retry after a Host/WebUI restart rather than silently losing the last input.
        if (!stopped) { pending = true; timer ??= setTimeout(send, 15_000); }
      });
    };
    const activity = () => {
      pending = true;
      if (timer !== undefined) return;
      const delay = Math.max(0, 15_000 - (Date.now() - lastSent));
      if (delay === 0) send();
      else timer = setTimeout(send, delay);
    };
    const visible = () => { if (document.visibilityState === "visible") activity(); };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "input"] as const;
    for (const event of events) window.addEventListener(event, activity, { passive: true, capture: true });
    window.addEventListener("focus", activity);
    document.addEventListener("visibilitychange", visible);
    visible();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, activity, true);
      window.removeEventListener("focus", activity);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return null;
}
