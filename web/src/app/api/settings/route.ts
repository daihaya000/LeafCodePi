import { NextResponse } from "next/server";
import { readSettingsSnapshot } from "@/lib/pi/settings-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** タブ復帰時などの一括再取得用。起動時は (app)/layout がサーバ描画で埋め込む。 */
export async function GET() {
  return NextResponse.json({ values: readSettingsSnapshot() });
}