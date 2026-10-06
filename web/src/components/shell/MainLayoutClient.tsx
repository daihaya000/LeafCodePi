"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { BotRoutineNotifier } from "@/components/BotRoutineNotifier";
import { NotificationSoundSync } from "@/components/NotificationSoundSync";
import { maybeRedirectToLocalhost } from "@/lib/localhost-redirect";
import {
  INITIAL_RESTART_PROBE,
  HOST_RESTART_ESTIMATE_MS,
  formatRestartCountdown,
  isRestartOverlayVisible,
  nextRestartProbe,
  nextRestartProbeDelayMs,
  RESTART_PROBE_FAST_MS,
  restartEstimateRemainingMs,
  restartOverlayMessage,
  WEBUI_RESTART_ABORTED_EVENT,
  WEBUI_RESTART_EVENT,
  type RestartOverlayTarget,
} from "@/lib/webui-restart";
import type { HealthDto } from "@/lib/types";

function WebUiRestartOverlay() {
  const [restarting, setRestarting] = useState(false);
  const [target, setTarget] = useState<RestartOverlayTarget | null>(null);
  const [abortHint, setAbortHint] = useState<string | null>(null);
  const [restartStartedAt, setRestartStartedAt] = useState<number | null>(null);
  const [estimatedRemainingMs, setEstimatedRemainingMs] = useState(HOST_RESTART_ESTIMATE_MS);
  const probeRef = useRef(INITIAL_RESTART_PROBE);

  useEffect(() => {
    if (!restarting || target !== "host" || restartStartedAt === null) return;
    const timer = window.setInterval(() => {
      setEstimatedRemainingMs(restartEstimateRemainingMs(restartStartedAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [restarting, target, restartStartedAt]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      let sample: { startedAt: number | null } | null = null;
      try {
        const response = await fetch(`/api/health?restart=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(4_000),
        });
        const body = (await response.json().catch(() => null)) as HealthDto | null;
        if (response.ok && typeof body?.engineOk === "boolean") {
          sample = { startedAt: typeof body.startedAt === "number" ? body.startedAt : null };
        }
      } catch {
        // 到達不能。下のオフライン判定に回す。
      }
      if (cancelled) return;
      const { state, reload, gaveUp } = nextRestartProbe(probeRef.current, sample);
      probeRef.current = state;
      setRestarting(isRestartOverlayVisible(state));
      if (!state.requested) setTarget(null);
      if (gaveUp) {
        const message = "再起動が開始されなかったため、待機を解除しました。";
        setAbortHint(message);
        window.dispatchEvent(
          new CustomEvent(WEBUI_RESTART_ABORTED_EVENT, { detail: { message } }),
        );
      }
      // リロードが効かなかった場合に取り残されないよう、ポーリングは止めない。
      if (reload) window.location.reload();
      schedule(nextRestartProbeDelayMs(state, document.visibilityState === "hidden"));
    };
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void check();
      }, delayMs);
    };
    const handleVisibility = () => {
      // Back in front: probe now instead of waiting out the hidden-tab interval.
      if (document.visibilityState === "visible" && timer) schedule(0);
    };

    const handleRestartRequested = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: RestartOverlayTarget }>).detail;
      const nextTarget = detail?.target === "host" ? "host" : "webui";
      const requestedAt = Date.now();
      setTarget(nextTarget);
      setAbortHint(null);
      setRestartStartedAt(nextTarget === "host" ? requestedAt : null);
      setEstimatedRemainingMs(HOST_RESTART_ESTIMATE_MS);
      probeRef.current = {
        ...probeRef.current,
        requested: true,
        requestedAt,
      };
      setRestarting(true);
      // Switch to the fast cadence now; an idle probe may be up to a minute away.
      if (timer) schedule(RESTART_PROBE_FAST_MS);
    };
    window.addEventListener(WEBUI_RESTART_EVENT, handleRestartRequested);
    document.addEventListener("visibilitychange", handleVisibility);
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener(WEBUI_RESTART_EVENT, handleRestartRequested);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  if (restarting) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm"
      >
        <div className="flex min-w-64 flex-col items-center gap-3 rounded-2xl border border-border bg-surface/95 px-8 py-7 text-center shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          <Loader2 className="h-8 w-8 animate-spin text-accent" aria-hidden="true" />
          <p className="text-sm font-semibold">{restartOverlayMessage(target)}</p>
          {target === "host" && (
            <p className="text-xs text-muted" aria-live="off">
              {estimatedRemainingMs > 0
                ? `推定残り時間: ${formatRestartCountdown(estimatedRemainingMs)}`
                : "推定時間を超過。再接続を待っています。"}
            </p>
          )}
          <p className="text-xs text-muted">再接続されると自動的にページを更新します。</p>
        </div>
      </div>
    );
  }
  if (!abortHint) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[100] max-w-md -translate-x-1/2 rounded-xl border border-warning/40 bg-surface px-4 py-3 text-center text-sm text-warning shadow-lg"
    >
      <p>{abortHint}</p>
      <button
        type="button"
        className="mt-2 text-xs text-muted underline"
        onClick={() => setAbortHint(null)}
      >
        閉じる
      </button>
    </div>
  );
}

export function MainLayoutClient({
  children,
  initialSettings,
}: {
  children: React.ReactNode;
  initialSettings?: Record<string, string | null>;
}) {
  // 本家同様: ホストPC上のブラウザが LAN / Tailscale IP で開いたら 127.0.0.1 へ
  // 移す。リモート端末はループバックに届かないのでリダイレクトされない。
  useEffect(() => {
    void maybeRedirectToLocalhost();
  }, []);

  return (
    <>
      <AppShell initialSettings={initialSettings}>{children}</AppShell>
      <NotificationSoundSync />
      <BotRoutineNotifier />
      <WebUiRestartOverlay />
    </>
  );
}
