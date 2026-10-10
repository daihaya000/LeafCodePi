import { lazy, Suspense, useLayoutEffect } from "react";
import { ThemeProvider } from "next-themes";
import { AutoUpdateActivity } from "@/components/shell/AutoUpdateActivity";
import { HostnameProvider } from "@/components/shell/HostnameContext";
import { SettingsGate } from "./SettingsGate";
import { usePathname } from "./navigation";
import { useWebUiPresentation } from "./presentation";

const ProtectedApp = lazy(() => import("./ProtectedApp"));
const LoginForm = lazy(() => import("../app/login/LoginForm"));
const loading = <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text"><p className="text-sm text-muted">読み込み中…</p></main>;

export function Application() {
  const pathname = usePathname(), { presentation, error, retry } = useWebUiPresentation();
  // Sidebar adds unread counts in a passive effect; establish its base title first.
  useLayoutEffect(() => { if (presentation) document.title = `LCP ${presentation.hostname}`; }, [presentation]);
  return <ThemeProvider attribute="class" defaultTheme="light" enableSystem themes={["light", "dark", "oyster", "system"]}>
    <HostnameProvider hostname={presentation?.hostname ?? ""}>
      <Suspense fallback={loading}>
        {pathname === "/login"
          // Do not delay fragment cleanup/sign-in behind a metadata request.
          ? <LoginForm authFileDisplayPath={presentation?.authFileDisplayPath ?? "webui-auth.json"} />
          : presentation ? <SettingsGate><AutoUpdateActivity /><ProtectedApp /></SettingsGate>
          : error ? <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text" role="alert"><div className="text-center"><p className="text-sm text-muted">画面情報を取得できません。再試行してください。</p><button className="mt-4 rounded-xl bg-primary px-4 py-2 text-sm text-primary-fg" onClick={retry}>再試行</button></div></main>
          : loading}
      </Suspense>
    </HostnameProvider>
  </ThemeProvider>;
}
