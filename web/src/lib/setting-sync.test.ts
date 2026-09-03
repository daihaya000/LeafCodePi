import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => client);

import { createSettingSync } from "@/lib/setting-sync";

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
}

describe("setting-sync", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    client.getJson.mockReset();
    client.sendJson.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("retries failed saves and restores a persisted pending save after reload", async () => {
    const options = {
      storageKey: "test:setting",
      serverPath: "/api/settings/test",
      eventName: "test:setting",
    };
    client.sendJson.mockRejectedValue(new Error("server restarting"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = createSettingSync(options);
    const saving = first.writeToServer("latest");
    await vi.runAllTimersAsync();
    await saving;

    expect(client.sendJson).toHaveBeenCalledTimes(4);
    expect(storage.getItem("test:setting:server-pending")).toBe('"latest"');

    client.sendJson.mockResolvedValue({ value: "latest" });
    client.getJson.mockResolvedValue({ value: "latest" });
    const afterReload = createSettingSync(options);

    await expect(afterReload.readFromServer()).resolves.toBe("latest");
    expect(client.sendJson).toHaveBeenLastCalledWith(
      "/api/settings/test",
      { value: "latest" },
      "PUT",
    );
    expect(storage.getItem("test:setting:server-pending")).toBeNull();
    warn.mockRestore();
  });
});
