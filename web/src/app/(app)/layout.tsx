import { MainLayoutClient } from "@/components/shell/MainLayoutClient";
import { headers } from "next/headers";
import { readServerSettingsSnapshot } from "@/lib/server-settings-snapshot";

export const dynamic = "force-dynamic";

/** 設定の正本（サーバ）を描画時に埋め込み、クライアントが取得待ちせずに起動できるようにする。 */
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  let initialSettings: Record<string, string | null> | undefined;
  try {
    const incoming = new Headers(await headers());
    const scheme = incoming.get("x-forwarded-proto") === "https" ? "https" : "http";
    initialSettings = await readServerSettingsSnapshot(new Request(`${scheme}://${incoming.get("host") ?? "localhost"}/`, { headers: incoming }));
  } catch {
    // 読めない場合はクライアントが /api/settings から取得する。
    // No local settings fallback or private exception text in the Web process.
  }
  return <MainLayoutClient initialSettings={initialSettings}>{children}</MainLayoutClient>;
}