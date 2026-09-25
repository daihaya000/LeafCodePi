import { MainLayoutClient } from "@/components/shell/MainLayoutClient";
import { readSettingsSnapshot } from "@/lib/pi/settings-snapshot";

export const dynamic = "force-dynamic";

/** 設定の正本（サーバ）を描画時に埋め込み、クライアントが取得待ちせずに起動できるようにする。 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  let initialSettings: Record<string, string | null> | undefined;
  try {
    initialSettings = readSettingsSnapshot();
  } catch (err) {
    // 読めない場合はクライアントが /api/settings から取得する。
    console.warn("settings snapshot failed", err);
  }
  return <MainLayoutClient initialSettings={initialSettings}>{children}</MainLayoutClient>;
}