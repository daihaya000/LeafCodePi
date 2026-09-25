import { NextResponse } from "next/server";
import { getSetting } from "@/lib/pi/web-settings";
import { ALLOWED_SETTING_KEYS } from "@/lib/pi/setting-validation";
import { readAutoResumeModeSetting, readHangTimeoutSettingMs } from "@/lib/pi/hang-settings";
import { AUTO_RESUME_MODE_SETTING_KEY, HANG_TIMEOUT_SETTING_KEY } from "@/lib/hang-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 起動時の一括hydrate用。サーバー保存値を正本としてクライアントのキャッシュへ反映する。 */
export async function GET() {
  const values: Record<string, string | null> = {};
  for (const key of ALLOWED_SETTING_KEYS) values[key] = getSetting(key);
  values[HANG_TIMEOUT_SETTING_KEY] = String(readHangTimeoutSettingMs());
  values[AUTO_RESUME_MODE_SETTING_KEY] = readAutoResumeModeSetting();
  return NextResponse.json({ values });
}
