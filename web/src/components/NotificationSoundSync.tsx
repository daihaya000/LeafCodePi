import { useEffect } from "react";
import { reconcileNotificationSound } from "@/lib/notification-sound-settings";

/** Keep notification sound settings aligned with the durable server copy. */
export function NotificationSoundSync() {
  useEffect(() => {
    void reconcileNotificationSound();
  }, []);

  return null;
}
