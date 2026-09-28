import { useSyncExternalStore } from "react";
import { NOTIFICATION_DELIVERY_SETTING_KEY } from "@/lib/notification-delivery-key";
import { registerServerSetting } from "@/lib/setting-sync";

const EVENT_NAME = "leafcode:notification-delivery";
let enabled = true;

/** Server-synced global gate shared by every browser Notification producer. */
export function getNotificationDeliveryEnabled(): boolean {
  return enabled;
}

export function setNotificationDeliveryEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT_NAME));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

export function useNotificationDeliveryEnabled(): boolean {
  // During SSR hydration, fail closed until the server setting is available on the client.
  return useSyncExternalStore(subscribe, getNotificationDeliveryEnabled, () => false);
}

// Initial server-rendered settings and tab-focus refresh both update this snapshot.
registerServerSetting(NOTIFICATION_DELIVERY_SETTING_KEY, (value) => {
  setNotificationDeliveryEnabled(value !== "0");
});
