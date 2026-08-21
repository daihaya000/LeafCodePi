"use client";

import { useEffect } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { maybeRedirectToLocalhost } from "@/lib/localhost-redirect";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  // 本家同様: ホストPC上のブラウザが LAN / Tailscale IP で開いたら 127.0.0.1 へ
  // 移す。リモート端末はループバックに届かないのでリダイレクトされない。
  useEffect(() => {
    void maybeRedirectToLocalhost();
  }, []);

  return <AppShell>{children}</AppShell>;
}
