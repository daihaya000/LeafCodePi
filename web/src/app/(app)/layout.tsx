"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { NotificationSoundSync } from "@/components/NotificationSoundSync";
import { GlobalAttentionProvider } from "@/components/shell/GlobalAttentionProvider";
import { maybeRedirectToLocalhost } from "@/lib/localhost-redirect";
import {
  INITIAL_RESTART_PROBE,
  isRestartOverlayVisible,
  nextRestartProbe,
} from "@/lib/webui-restart";
import type { HealthDto } from "@/lib/types";

function WebUiRestartOverlay() {
  const [restarting, setRestarting] = useState(false);
  const probeRef = useRef(INITIAL_RESTART_PROBE);

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
      const { state, reload } = nextRestartProbe(probeRef.current, sample);
      probeRef.current = state;
      setRestarting(isRestartOverlayVisible(state));
      // リロードが効かなかった場合に取り残されないよう、ポーリングは止めない。
      if (reload) window.location.reload();
      timer = setTimeout(() => void check(), 1_500);
    };

    const handleRestartRequested = () => {
      probeRef.current = { ...probeRef.current, requested: true };
      setRestarting(true);
    };
    window.addEventListener("leafcode:webui-restart", handleRestartRequested);
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("leafcode:webui-restart", handleRestartRequested);
    };
  }, []);

  if (!restarting) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm"
    >
      <div className="flex min-w-64 flex-col items-center gap-3 rounded-2xl border border-border bg-surface/95 px-8 py-7 text-center shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
        <Loader2 className="h-8 w-8 animate-spin text-accent" aria-hidden="true" />
        <p className="text-sm font-semibold">WebUIを再起動しています…</p>
        <p className="text-xs text-muted">再接続されると自動的にページを更新します。</p>
      </div>
    </div>
  );
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  // 本家同様: ホストPC上のブラウザが LAN / Tailscale IP で開いたら 127.0.0.1 へ
  // 移す。リモート端末はループバックに届かないのでリダイレクトされない。
  useEffect(() => {
    void maybeRedirectToLocalhost();
  }, []);

  return (
    <>
      <AppShell>{children}</AppShell>
      <NotificationSoundSync />
      <GlobalAttentionProvider />
      <WebUiRestartOverlay />
    </>
  );
}
