import { getSetting } from "@/lib/pi/web-settings";
import { NOTIFICATION_DELIVERY_SETTING_KEY } from "@/lib/notification-delivery-key";
import { ALLOWED_SETTING_KEYS } from "@/lib/pi/setting-validation";
import { readAutoResumeModeSetting, readHangTimeoutSettingMs } from "@/lib/pi/hang-settings";
import { AUTO_RESUME_MODE_SETTING_KEY, HANG_TIMEOUT_SETTING_KEY } from "@/lib/hang-timeout";

/** クライアントのキャッシュへ反映する設定の一括スナップショット（サーバが正本）。 */
export function readSettingsSnapshot(): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const key of ALLOWED_SETTING_KEYS) values[key] = getSetting(key);
  // Notification delivery is writable only through the guarded notifications API, not generic settings PUT.
  values[NOTIFICATION_DELIVERY_SETTING_KEY] = getSetting(NOTIFICATION_DELIVERY_SETTING_KEY);
  values[HANG_TIMEOUT_SETTING_KEY] = String(readHangTimeoutSettingMs());
  values[AUTO_RESUME_MODE_SETTING_KEY] = readAutoResumeModeSetting();
  return values;
}