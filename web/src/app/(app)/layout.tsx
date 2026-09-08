"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { NotificationSoundSync } from "@/components/NotificationSoundSync";
import { GlobalAttentionProvider } from "@/components/shell/GlobalAttentionProvider";
import { maybeRedirectToLocalhost } from "@/lib/localhost-redirect";

function WebUiRestartOverlay() {
  const [restarting, setRestarting] = useState(false);
  const connectedRef = useRef(false);
  const offlineRef = useRef(false);
  const restartingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      try {
        const response = await fetch(`/api/health?restart=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(4_000),
        });
        const body = (await response.json().catch(() => null)) as { engineOk?: unknown } | null;
        const healthy = response.ok && typeof body?.engineOk === "boolean";
        if (healthy) {
          if (restartingRef.current && offlineRef.current && !cancelled) window.location.reload();
          connectedRef.current = true;
        } else if (connectedRef.current && !cancelled) {
          restartingRef.current = true;
          offlineRef.current = true;
          setRestarting(true);
        }
      } catch {
        if (connectedRef.current && !cancelled) {
          restartingRef.current = true;
          offlineRef.current = true;
          setRestarting(true);
        }
      }
      if (!cancelled) timer = setTimeout(() => void check(), 1_500);
    };

    const handleRestartRequested = () => {
      restartingRef.current = true;
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
    <AppShell>
      <NotificationSoundSync />
      <GlobalAttentionProvider />
      {children}
      <WebUiRestartOverlay />
    </AppShell>
  );
}
