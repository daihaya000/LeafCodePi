import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const keys = new Map<string, string>();
  const settings = new Map<string, string>();
  const runtime = {
    registerProvider: vi.fn(),
    getAuth: vi.fn(async (id: string) => keys.has(id) ? { auth: { apiKey: keys.get(id) } } : undefined),
    login: vi.fn(async (id: string, _method: string, io: { prompt: () => Promise<string> }) => {
      keys.set(id, await io.prompt());
    }),
    logout: vi.fn(async (id: string) => { keys.delete(id); }),
  };
  return { keys, settings, runtime, create: vi.fn(async () => runtime) };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({ ModelRuntime: { create: mocks.create } }));
vi.mock("@/lib/pi/web-settings", () => ({
  getSetting: (key: string) => mocks.settings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => value === null ? mocks.settings.delete(key) : mocks.settings.set(key, value),
}));

import { getPushoverSettingsDto, readPushoverCredentials, savePushoverSettings } from "./pushover-config";

beforeEach(() => {
  mocks.keys.clear();
  mocks.settings.clear();
  vi.clearAllMocks();
  delete process.env.LEAFCODE_PI_PUSHOVER_TOKEN;
  delete process.env.LEAFCODE_PI_PUSHOVER_USER;
  delete process.env.LEAFCODE_PI_PUSHOVER_DEVICE;
});

describe("Pushover settings storage", () => {
  it("saves both keys in Pi auth storage, not in WebUI settings or DTO", async () => {
    await savePushoverSettings({ token: "token123", user: "user123", device: "iphone" });
    expect(mocks.keys.get("leafcode-pushover-token")).toBe("token123");
    expect(mocks.keys.get("leafcode-pushover-user")).toBe("user123");
    expect([...mocks.settings]).toEqual([["pushover-device", "iphone"]]);
    expect(await getPushoverSettingsDto()).toEqual({
      hasToken: true, hasUser: true, device: "iphone",
      envManaged: { token: false, user: false, device: false },
    });
    expect(await readPushoverCredentials()).toEqual({ token: "token123", user: "user123", device: "iphone" });
  });

  it("keeps omitted keys and clears explicit null keys", async () => {
    await savePushoverSettings({ token: "token123", user: "user123" });
    await savePushoverSettings({ token: null, device: null });
    expect(await getPushoverSettingsDto()).toMatchObject({ hasToken: false, hasUser: true, device: "" });
  });

  it("prefers environment-managed values and rejects their replacement", async () => {
    process.env.LEAFCODE_PI_PUSHOVER_TOKEN = "envToken";
    process.env.LEAFCODE_PI_PUSHOVER_DEVICE = "envPhone";
    await savePushoverSettings({ user: "storedUser" });
    expect(await getPushoverSettingsDto()).toEqual({
      hasToken: true, hasUser: true, device: "envPhone",
      envManaged: { token: true, user: false, device: true },
    });
    await expect(savePushoverSettings({ token: "overwrite", user: "other" })).rejects.toThrow("環境変数");
    expect(mocks.keys.get("leafcode-pushover-user")).toBe("storedUser");
  });
});
