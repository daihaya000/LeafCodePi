import { useEffect, useState, type ReactNode } from "react";
import { ensureServerSettingsHydrated } from "@/lib/setting-sync";
import { useRouter } from "./navigation";

/** Never mount a default writer on an unavailable/unauthorized settings snapshot. */
export function SettingsGate({ children }: { children: ReactNode }) {
  const [attempt, retry] = useState(0), [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const router = useRouter();
  useEffect(() => {
    let active = true;
    setState("loading");
    void ensureServerSettingsHydrated().then(() => { if (active) setState("ready"); }).catch(error => {
      if (!active) return;
      if (error?.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`, { scroll: false });
      } else setState("error");
    });
    return () => { active = false; };
  }, [attempt, router]);
  if (state === "ready") return children;
  return <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text" role={state === "error" ? "alert" : "status"} aria-busy={state === "loading"}>
    <div className="text-center"><p className="text-sm text-muted">{state === "error" ? "設定を取得できません。保存済み設定を保護するため起動を待機しています。" : "読み込み中…"}</p>
      {state === "error" && <button className="mt-4 rounded-xl bg-primary px-4 py-2 text-sm text-primary-fg" onClick={() => retry(value => value + 1)}>再試行</button>}
    </div>
  </main>;
}
