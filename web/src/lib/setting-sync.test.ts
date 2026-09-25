import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => client);

import {
  createSettingSync,
  hydrateServerSettings,
  primeServerSettings,
  refreshServerSettings,
  resetServerSettingsHydration,
} from "@/lib/setting-sync";

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
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: vi.fn() } });
    resetServerSettingsHydration();
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

  it("overwrites the local cache with the server value on boot hydration", async () => {
    storage.setItem("hydrate:a", "local");
    storage.setItem("hydrate:a:server-synced", "1");
    const sync = createSettingSync({ storageKey: "hydrate:a", serverPath: "/api/settings/hydrate-a", eventName: "e" });
    client.getJson.mockResolvedValue({ values: { "hydrate-a": "server" } });

    await hydrateServerSettings();

    expect(client.getJson).toHaveBeenCalledWith("/api/settings", undefined, { coalesce: false });
    expect(sync.read()).toBe("server");
  });

  it("migrates a local-only value once instead of clearing it", async () => {
    storage.setItem("hydrate:b", "local");
    client.getJson.mockResolvedValue({ values: { "hydrate-b": null } });
    client.sendJson.mockResolvedValue({ value: "local" });
    const sync = createSettingSync({ storageKey: "hydrate:b", serverPath: "/api/settings/hydrate-b", eventName: "e" });

    await hydrateServerSettings();
    await vi.runAllTimersAsync();

    expect(sync.read()).toBe("local");
    expect(client.sendJson).toHaveBeenCalledWith("/api/settings/hydrate-b", { value: "local" }, "PUT");
    expect(storage.getItem("hydrate:b:server-synced")).toBe("1");
  });

  it("keeps a pending local write instead of restoring the stale server value", async () => {
    storage.setItem("hydrate:c", "new");
    storage.setItem("hydrate:c:server-synced", "1");
    storage.setItem("hydrate:c:server-pending", '"new"');
    client.getJson.mockResolvedValue({ values: { "hydrate-c": "old" } });
    client.sendJson.mockResolvedValue({ value: "new" });
    const sync = createSettingSync({ storageKey: "hydrate:c", serverPath: "/api/settings/hydrate-c", eventName: "e" });

    await hydrateServerSettings();
    await vi.runAllTimersAsync();

    expect(sync.read()).toBe("new");
    expect(client.sendJson).toHaveBeenCalledWith("/api/settings/hydrate-c", { value: "new" }, "PUT");
  });

  it("applies the boot snapshot to settings registered after hydration", async () => {
    storage.setItem("hydrate:d:server-synced", "1");
    client.getJson.mockResolvedValue({ values: { "hydrate-d": "server" } });
    await hydrateServerSettings();

    const sync = createSettingSync({ storageKey: "hydrate:d", serverPath: "/api/settings/hydrate-d", eventName: "e" });

    expect(sync.read()).toBe("server");
  });

  it("does not hydrate settings that opt out", async () => {
    storage.setItem("hydrate:e", "local");
    storage.setItem("hydrate:e:server-synced", "1");
    const sync = createSettingSync({ storageKey: "hydrate:e", serverPath: "/api/settings/hydrate-e", eventName: "e", hydrate: false });
    client.getJson.mockResolvedValue({ values: { "hydrate-e": "server" } });

    await hydrateServerSettings();

    expect(sync.read()).toBe("local");
  });

  it("drops a pending write the server rejects so hydration can apply the server value", async () => {
    storage.setItem("hydrate:f", "bad");
    storage.setItem("hydrate:f:server-synced", "1");
    storage.setItem("hydrate:f:server-pending", '"bad"');
    client.getJson.mockResolvedValue({ values: { "hydrate-f": "good" } });
    client.sendJson.mockRejectedValue(Object.assign(new Error("invalid value"), { status: 400 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sync = createSettingSync({ storageKey: "hydrate:f", serverPath: "/api/settings/hydrate-f", eventName: "e" });

    await hydrateServerSettings();
    await vi.runAllTimersAsync();

    expect(client.sendJson).toHaveBeenCalledTimes(1);
    expect(storage.getItem("hydrate:f:server-pending")).toBeNull();
    resetServerSettingsHydration();
    await hydrateServerSettings();
    expect(sync.read()).toBe("good");
    warn.mockRestore();
  });

  it("applies an embedded snapshot synchronously without fetching", () => {
    storage.setItem("hydrate:g:server-synced", "1");
    const sync = createSettingSync({ storageKey: "hydrate:g", serverPath: "/api/settings/hydrate-g", eventName: "e" });

    primeServerSettings({ "hydrate-g": "server" });

    expect(sync.read()).toBe("server");
    expect(client.getJson).not.toHaveBeenCalled();
  });

  it("does not revert a value changed in this tab while a refresh was in flight", async () => {
    storage.setItem("hydrate:h", "old");
    storage.setItem("hydrate:h:server-synced", "1");
    const sync = createSettingSync({ storageKey: "hydrate:h", serverPath: "/api/settings/hydrate-h", eventName: "e" });
    let respond: (value: unknown) => void = () => undefined;
    client.getJson.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    client.sendJson.mockResolvedValue({ value: "new" });

    const refreshing = refreshServerSettings();
    sync.write("new");
    await sync.writeToServer("new");
    respond({ values: { "hydrate-h": "old" } });
    await refreshing;

    expect(sync.read()).toBe("new");
  });});
