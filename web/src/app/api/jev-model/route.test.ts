import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { GET, PUT } from "./route";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/pi/jev-model-config", () => ({ getJevModelSettingsDto: mocks.get, saveJevModelSettings: mocks.save }));
const dto = { settings: DEFAULT_JEV_MODEL_SETTINGS, hasApiKey: { typesafe: true, compatible: false } };
const request = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/jev-model", {
  method: "PUT",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(dto);
  mocks.save.mockResolvedValue(undefined);
});

describe("Jev model settings API", () => {
  it("returns settings and key presence without credentials", async () => {
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
    const malformed = new NextRequest("http://localhost/api/jev-model", { method: "PUT", headers: { "content-type": "application/json" }, body: "test-only-secret{" });
    const invalid = await PUT(malformed);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("test-only-secret");
  });
});
