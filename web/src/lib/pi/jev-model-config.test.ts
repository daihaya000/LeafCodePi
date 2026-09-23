import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS, JEV_MODEL_SETTING_KEY, normalizeJevModelSettings } from "@/lib/jev-model-settings";
import { getJevModelSettingsDto, jevCredentialProviderId, readJevApiKey, readJevModelSettings, saveJevModelSettings } from "./jev-model-config";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("./web-settings", () => ({
  getSetting: (key: string) => store.get(key) ?? null,
  setSetting: (key: string, value: string) => store.set(key, value),
}));

let dir: string;
beforeEach(() => {
  store.clear();
  dir = mkdtempSync(join(tmpdir(), "lcp-jev-config-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const compatible = {
  ...DEFAULT_JEV_MODEL_SETTINGS,
  provider: "compatible" as const,
  compatibleBaseUrl: "http://localhost:8080/v1",
  compatibleModel: "local-judge",
};

describe("Jev model configuration", () => {
  it("defaults to TypeSafe but fails closed on corrupt persisted settings", () => {
    expect(readJevModelSettings()).toEqual(DEFAULT_JEV_MODEL_SETTINGS);
    store.set(JEV_MODEL_SETTING_KEY, "invalid-json");
    expect(() => readJevModelSettings()).toThrow();
  });

  it("normalizes a base URL and drops unrecognized fields", () => {
    expect(normalizeJevModelSettings({ ...compatible, compatibleBaseUrl: " http://LOCALHOST:8080/v1/ ", extra: "ignored" })).toEqual(compatible);
  });

  it.each([
    { provider: "openai" },
    { compatibleBaseUrl: "" },
    { compatibleBaseUrl: "file:///tmp/jev" },
    { compatibleBaseUrl: "https://user:password@example.com/v1" },
    { compatibleBaseUrl: "https://example.com/v1?key=test" },
    { compatibleBaseUrl: "https://example.com/v1#fragment" },
    { compatibleBaseUrl: "https://example.com/v1?" },
    { compatibleBaseUrl: "https://example.com/v1#" },
    { compatibleBaseUrl: "https://example.com/v1/systemone/" },
    { compatibleModel: "bad\nmodel" },
    { typesafeModel: "" },
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
  ])("rejects invalid configuration %j", (patch) => {
    expect(() => normalizeJevModelSettings({ ...compatible, ...patch })).toThrow();
  });

  it("persists credentials in Pi auth storage, not settings or DTOs", async () => {
    await saveJevModelSettings(compatible, "test-only-compatible-key");
    expect(readJevModelSettings()).toEqual(compatible);
    expect(await readJevApiKey(compatible)).toBe("test-only-compatible-key");
    const dto = await getJevModelSettingsDto();
    expect(dto.hasApiKey).toEqual({ typesafe: false, compatible: true });
    expect(JSON.stringify(dto)).not.toContain("test-only-compatible-key");
    expect(store.get(JEV_MODEL_SETTING_KEY)).not.toContain("test-only-compatible-key");
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(auth[jevCredentialProviderId(compatible)]).toMatchObject({ type: "api_key", key: "test-only-compatible-key" });
    await saveJevModelSettings({ ...compatible, compatibleModel: "second-model" });
    expect(await readJevApiKey(compatible)).toBe("test-only-compatible-key");
    await saveJevModelSettings(compatible, null);
    expect(await readJevApiKey(compatible)).toBeUndefined();
  });

  it("never reuses a TypeSafe or another endpoint's credential", async () => {
    await saveJevModelSettings(DEFAULT_JEV_MODEL_SETTINGS, "test-only-typesafe-key");
    expect(await readJevApiKey(compatible)).toBeUndefined();
    await saveJevModelSettings(compatible, "test-only-compatible-key");
    expect(await readJevApiKey({ ...compatible, compatibleBaseUrl: "http://localhost:9090/v1" })).toBeUndefined();
    await saveJevModelSettings({ ...compatible, provider: "typesafe" });
    expect(await readJevApiKey(DEFAULT_JEV_MODEL_SETTINGS)).toBe("test-only-typesafe-key");
    expect((await getJevModelSettingsDto()).hasApiKey).toEqual({ typesafe: true, compatible: true });
  });

  it("keeps the existing TypeSafe environment-key behavior", async () => {
    await expect(readJevApiKey(DEFAULT_JEV_MODEL_SETTINGS)).rejects.toThrow();
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-env-key");
    expect(await readJevApiKey(DEFAULT_JEV_MODEL_SETTINGS)).toBe("test-only-env-key");
    expect(await readJevApiKey(compatible)).toBeUndefined();
  });
});
