// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_DELIVERY_SETTING_KEY } from "./notification-delivery-key";
import { getNotificationDeliveryEnabled, setNotificationDeliveryEnabled } from "./notification-delivery-client";
import { primeServerSettings, refreshServerSettings, resetServerSettingsHydration } from "./setting-sync";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => ({ getJson: mocks.get, sendJson: vi.fn() }));

beforeEach(() => {
  resetServerSettingsHydration();
  setNotificationDeliveryEnabled(true);
});
afterEach(() => {
  setNotificationDeliveryEnabled(true);
  vi.clearAllMocks();
});

describe("shared notification delivery setting", () => {
  it("hydrates OFF from the server-rendered snapshot", () => {
    primeServerSettings({ [NOTIFICATION_DELIVERY_SETTING_KEY]: "0" });
    expect(getNotificationDeliveryEnabled()).toBe(false);
  });

  it("applies other-tab updates when server settings refresh", async () => {
    primeServerSettings({ [NOTIFICATION_DELIVERY_SETTING_KEY]: "0" });
    mocks.get.mockResolvedValue({ values: { [NOTIFICATION_DELIVERY_SETTING_KEY]: null } });
    await refreshServerSettings();
    expect(getNotificationDeliveryEnabled()).toBe(true);
  });

  it("notifies listeners only after the effective value changes", () => {
    const listener = vi.fn();
    window.addEventListener("leafcode:notification-delivery", listener);
    try {
      setNotificationDeliveryEnabled(false);
      setNotificationDeliveryEnabled(false);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("leafcode:notification-delivery", listener);
    }
  });
});
