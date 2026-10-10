import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { AutoUpdateActivity } from "@/components/shell/AutoUpdateActivity";
import { HostnameProvider } from "@/components/shell/HostnameContext";
import { SettingsGate } from "./SettingsGate";
import { installNavigation, usePathname } from "./navigation";
import "../app/globals.css";

const ProtectedApp = lazy(() => import("./ProtectedApp"));
const LoginForm = lazy(() => import("../app/login/LoginForm"));
function Application() {
  const pathname = usePathname();
  return <ThemeProvider attribute="class" defaultTheme="light" enableSystem themes={["light", "dark", "oyster", "system"]}>
    <HostnameProvider hostname={window.location.hostname}>
      <Suspense fallback={<main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text"><p className="text-sm text-muted">読み込み中…</p></main>}>
        {pathname === "/login" ? <LoginForm authFileDisplayPath="webui-auth.json" /> : <SettingsGate><AutoUpdateActivity /><ProtectedApp /></SettingsGate>}
      </Suspense>
    </HostnameProvider>
  </ThemeProvider>;
}
installNavigation();
createRoot(document.getElementById("root")!).render(<Application />);
