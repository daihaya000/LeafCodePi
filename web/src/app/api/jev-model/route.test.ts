import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { GET, PUT } from "@backend-runtime/configuration/handlers/jev-model/route";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), list: vi.fn(), latency: vi.fn() }));
vi.mock("@/lib/pi/jev-model-config", () => ({ getJevModelSettingsDto: mocks.get, saveJevModelSettings: mocks.save }));
vi.mock("@/lib/pi/jev-latency", () => ({ readJevLatencyStats: mocks.latency }));
vi.mock("@/lib/pi/harness", () => ({ listJevModels: mocks.list }));
const ref = { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "one" };
const candidate = { ...ref, providerName: "OpenRouter", name: "Jev", baseUrl: "https://openrouter.ai/api/v1", source: "catalog" };
const dto = { settings: DEFAULT_JEV_MODEL_SETTINGS, hasApiKey: { typesafe: true, compatible: false }, models: [], latency: {} };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost/api/jev-model", {
  method: "PUT",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(dto);
  mocks.save.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  mocks.latency.mockReturnValue({});
});

describe("Jev model settings API", () => {
  it("returns settings and key presence without credentials", async () => {
    expect(await (await GET()).json()).toEqual(dto);
  });

  it("includes recorded per-model latency in the settings response", async () => {
    const latency = { "jev-1.13.0": { count: 3, averageMs: 410, lastMs: 380 } };
    mocks.latency.mockReturnValue(latency);
    expect(await (await GET()).json()).toEqual({ ...dto, latency });
  });

  it("returns discovered models without changing the active selection and accepts explicit refresh", async () => {
    mocks.list.mockResolvedValue([candidate]);
    const response = await GET(new Request("http://localhost/api/jev-model?refresh=1"));
    expect(await response.json()).toEqual({ ...dto, models: [candidate] });
    expect(mocks.list).toHaveBeenCalledWith(true);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves an existing provider reference but rejects unknown models or credential writes", async () => {
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref };
    mocks.list.mockResolvedValue([candidate]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(settings, undefined);
    mocks.save.mockClear();
    expect((await PUT(request({ settings, apiKey: null }))).status).toBe(400);
    mocks.list.mockResolvedValue([{ ...candidate, providerEnabled: false }]);
    expect((await PUT(request({ settings }))).status).toBe(400);
    mocks.list.mockResolvedValue([]);
    expect((await PUT(request({ settings }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves only detected enabled models when at least one provider is enabled", async () => {
    const second = { ...candidate, accountId: "two", modelId: "typesafe/jev-1.14" };
    const secondRef = { providerId: "openrouter", modelId: second.modelId, accountId: "two" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: secondRef, enabledModels: [secondRef, ref] };
    mocks.list.mockResolvedValue([candidate, second]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...settings, registeredModel: ref, enabledModels: [ref, secondRef] }, undefined);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    mocks.save.mockClear();
    mocks.list.mockResolvedValue([candidate, { ...second, providerEnabled: false }]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...settings, registeredModel: ref, enabledModels: [ref, secondRef] }, undefined);
    mocks.save.mockClear();
    mocks.list.mockResolvedValue([{ ...candidate, providerEnabled: false }, { ...second, providerEnabled: false }]);
    expect((await PUT(request({ settings }))).status).toBe(400);
    mocks.list.mockResolvedValue([candidate]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...settings, registeredModel: ref, enabledModels: [ref] }, undefined);
  });

  it("drops undetected selections and repairs the primary reference while retaining paused selections", async () => {
    const missing = { providerId: "commandcode", modelId: "typesafe/jev" };
    const pausedRef = { ...ref, accountId: "paused" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: missing, enabledModels: [missing, ref, pausedRef] };
    mocks.list.mockResolvedValue([candidate, { ...candidate, ...pausedRef, providerEnabled: false }]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...settings, registeredModel: ref, enabledModels: [ref, pausedRef] }, undefined);
  });

  it("does not save or select another account when all selected references are undetected", async () => {
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref, enabledModels: [ref] };
    mocks.list.mockResolvedValue([{ ...candidate, accountId: "unselected" }]);
    expect((await PUT(request({ settings }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.list.mockRejectedValue(new Error("offline"));
    expect((await PUT(request({ settings }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves fallback order by visible integrated provider rows, not interleaved accounts", async () => {
    const first = { ...candidate, integrated: true, accountId: "one" };
    const second = { ...candidate, integrated: true, accountId: "two", modelId: "typesafe/jev-1.14" };
    const command = { ...candidate, integrated: true, providerId: "commandcode", accountId: "one" };
    const commandSecond = { ...command, accountId: "two", modelId: "typesafe/jev-1.14" };
    const refOf = (model: typeof candidate) => ({ providerId: model.providerId, modelId: model.modelId, accountId: model.accountId });
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", enabledModels: [commandSecond, second, command, first].map(refOf) };
    mocks.list.mockResolvedValue([first, command, second, commandSecond]);
    expect((await PUT(request({ settings }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...settings, registeredModel: refOf(first), enabledModels: [first, second, command, commandSecond].map(refOf) }, undefined);
  });

  it("keeps manual settings available if catalog discovery fails", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    expect(await (await GET()).json()).toEqual(dto);
  });

  it("saves validated settings and a key but never echoes the submitted key", async () => {
    const response = await PUT(request({ settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey: "test-only-key" }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(DEFAULT_JEV_MODEL_SETTINGS, "test-only-key");
    expect(await response.json()).toEqual(dto);
  });

  it.each([undefined, null])("distinguishes keeping and deleting credentials (%s)", async (apiKey) => {
    expect((await PUT(request({ settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(DEFAULT_JEV_MODEL_SETTINGS, apiKey);
  });

  it.each([
    null,
    { settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "other" } },
    { settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible" } },
    { settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey: 123 },
    { settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey: "header\ninjection" },
  ])("rejects invalid input without writes", async (body) => {
    expect((await PUT(request(body))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and non-JSON writes", async () => {
    expect((await PUT(request({ settings: DEFAULT_JEV_MODEL_SETTINGS }, { origin: "https://other.example" }))).status).toBe(403);
    expect((await PUT(request({ settings: DEFAULT_JEV_MODEL_SETTINGS }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not expose secrets in storage or JSON parse errors", async () => {
    mocks.save.mockRejectedValue(new Error("test-only-secret"));
    const response = await PUT(request({ settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey: "test-only-secret" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("test-only-secret");
    const malformed = new Request("http://localhost/api/jev-model", { method: "PUT", headers: { "content-type": "application/json" }, body: "test-only-secret{" });
    const invalid = await PUT(malformed);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("test-only-secret");
  });
});
