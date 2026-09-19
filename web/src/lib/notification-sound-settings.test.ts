// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("./client", () => ({ getJson, sendJson }));

import {
  clampNotificationSoundVolume,
  DEFAULT_BOT_NOTIFICATION_SOUND_TYPE,
  DEFAULT_NOTIFICATION_SOUND_TYPE,
  DEFAULT_NOTIFICATION_SOUND_VOLUME,
  isNotificationSoundType,
  readNotificationSoundSettings,
  readNotificationSoundType,
  readNotificationSoundVolume,
  reconcileNotificationSound,
  subscribeNotificationSound,
  syncNotificationSoundToServer,
  writeNotificationSoundType,
  writeNotificationSoundVolume,
} from "./notification-sound-settings";

describe("notification-sound-settings", () => {
  beforeEach(() => {
    localStorage.clear();
    getJson.mockReset();
    sendJson.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("uses standard sound for Code and clear for Bot at full volume by default", () => {
    expect(readNotificationSoundType()).toBe(DEFAULT_NOTIFICATION_SOUND_TYPE);
    expect(readNotificationSoundType("bot")).toBe(DEFAULT_BOT_NOTIFICATION_SOUND_TYPE);
    expect(DEFAULT_BOT_NOTIFICATION_SOUND_TYPE).not.toBe(DEFAULT_NOTIFICATION_SOUND_TYPE);
    expect(readNotificationSoundVolume()).toBe(DEFAULT_NOTIFICATION_SOUND_VOLUME);
  });

  it("validates sound types and clamps volume", () => {
    expect(isNotificationSoundType("standard")).toBe(true);
    expect(isNotificationSoundType("soft")).toBe(true);
    expect(isNotificationSoundType("clear")).toBe(true);
    expect(isNotificationSoundType("loud")).toBe(false);
    expect(isNotificationSoundType(null)).toBe(false);

    expect(clampNotificationSoundVolume(Number.NaN)).toBe(100);
    expect(clampNotificationSoundVolume(-1)).toBe(0);
    expect(clampNotificationSoundVolume(101)).toBe(101);
    expect(clampNotificationSoundVolume(201)).toBe(200);
    expect(clampNotificationSoundVolume(42.6)).toBe(43);
  });

  it("writes and reads the browser settings per channel", () => {
    writeNotificationSoundType("soft");
    writeNotificationSoundType("standard", "bot");
    writeNotificationSoundVolume(35);

    expect(readNotificationSoundType()).toBe("soft");
    expect(readNotificationSoundType("bot")).toBe("standard");
    expect(readNotificationSoundSettings()).toEqual({
      code: "soft",
      bot: "standard",
      volume: 35,
    });
  });

  it("falls back to each channel default when the stored value is invalid", () => {
    writeNotificationSoundType("loud" as never);
    writeNotificationSoundType("loud" as never, "bot");

    expect(readNotificationSoundType()).toBe(DEFAULT_NOTIFICATION_SOUND_TYPE);
    expect(readNotificationSoundType("bot")).toBe(DEFAULT_BOT_NOTIFICATION_SOUND_TYPE);
  });

  it("notifies same-tab subscribers and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationSound(listener);

    writeNotificationSoundType("clear");
    expect(listener).toHaveBeenCalledOnce();

    writeNotificationSoundType("standard", "bot");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    writeNotificationSoundVolume(20);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reconciles server values into the browser copy", async () => {
    writeNotificationSoundType("soft");
    writeNotificationSoundVolume(35);
    getJson
      .mockResolvedValueOnce({ value: "clear" })
      .mockResolvedValueOnce({ value: "soft" })
      .mockResolvedValueOnce({ value: "70" });

    await reconcileNotificationSound();

    expect(readNotificationSoundType()).toBe("clear");
    expect(readNotificationSoundType("bot")).toBe("soft");
    expect(readNotificationSoundVolume()).toBe(70);
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("seeds customized browser values when the server is unset", async () => {
    writeNotificationSoundType("soft");
    writeNotificationSoundVolume(35);
    getJson.mockResolvedValue({ value: null });

    await reconcileNotificationSound();

    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/notification-sound-type",
      { value: "soft" },
      "PUT",
    );
    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/notification-sound-type-bot",
      { value: DEFAULT_BOT_NOTIFICATION_SOUND_TYPE },
      "PUT",
    );
    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/notification-sound-volume",
      { value: "35" },
      "PUT",
    );
  });

  it("does not write anything when the browser and server are both default", async () => {
    getJson.mockResolvedValue({ value: null });

    await reconcileNotificationSound();

    expect(sendJson).not.toHaveBeenCalled();
  });

  it("syncs both channels and the shared volume to the server", async () => {
    await syncNotificationSoundToServer({ code: "clear", bot: "standard", volume: 80 });

    expect(sendJson).toHaveBeenNthCalledWith(
      1,
      "/api/settings/notification-sound-type",
      { value: "clear" },
      "PUT",
    );
    expect(sendJson).toHaveBeenNthCalledWith(
      2,
      "/api/settings/notification-sound-type-bot",
      { value: "standard" },
      "PUT",
    );
    expect(sendJson).toHaveBeenNthCalledWith(
      3,
      "/api/settings/notification-sound-volume",
      { value: "80" },
      "PUT",
    );
  });
});
