import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => client);

import {
  AUTO_OPTIMIZE_EVENT,
  AUTO_OPTIMIZE_SETTING_KEY,
  readAutoOptimizeMode,
  readAutoSettingsFromServer,
  readAutoShowModel,
  subscribeAutoSetting,
  writeAutoOptimizeMode,
  writeAutoRouteConfig,
  writeAutoSettingToServer,
  writeAutoShowModel,
} from "@/lib/auto-settings";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

describe("auto-settings", () => {
  let storage: MemoryStorage;
  let windowTarget: EventTarget & { localStorage?: MemoryStorage };

  beforeEach(() => {
    storage = new MemoryStorage();
    windowTarget = new EventTarget() as EventTarget & { localStorage?: MemoryStorage };
    windowTarget.localStorage = storage;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: windowTarget,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    client.getJson.mockReset();
    client.sendJson.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("uses safe defaults, writes synchronously, and notifies the same document", () => {
    expect(readAutoOptimizeMode()).toBe("cost");
    expect(readAutoShowModel()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, listener);
    writeAutoOptimizeMode("intelligence");
    writeAutoShowModel(true);

    expect(readAutoOptimizeMode()).toBe("intelligence");
    expect(readAutoShowModel()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.contexts[0]).toBe(windowTarget);
    unsubscribe();
  });

  it("removes empty route settings and mirrors server settings", async () => {
    writeAutoRouteConfig({ version: 2, modes: {} });
    expect(storage.getItem("webui:auto-route-overrides")).toBeNull();

    client.getJson
      .mockResolvedValueOnce({ value: "balanced" })
      .mockResolvedValueOnce({ value: "1" })
      .mockResolvedValueOnce({ value: null });
    await expect(readAutoSettingsFromServer()).resolves.toEqual({
      mode: "balanced",
      showModel: true,
    });

    await writeAutoSettingToServer(AUTO_OPTIMIZE_SETTING_KEY, "balanced");
    expect(client.sendJson).toHaveBeenCalledWith(
      "/api/settings/auto-optimize",
      { value: "balanced" },
      "PUT",
    );
  });

  it("uses the declared event name for local updates", () => {
    const listener = vi.fn();
    windowTarget.addEventListener(AUTO_OPTIMIZE_EVENT, listener);
    writeAutoOptimizeMode("balanced");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
