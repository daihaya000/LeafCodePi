import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "tts-settings-webui-token";
const mocks = vi.hoisted(() => ({
  readTtsConfig: vi.fn(),
  writeTtsConfig: vi.fn(),
  ttsHostCapabilities: vi.fn(),
  isSafeUnauthenticatedTtsUrl: vi.fn(),
}));
vi.mock("@/lib/tts-config", () => mocks);

import { GET, PATCH } from "@backend-runtime/configuration/handlers/settings/tts/route";

const authHeaders = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
  vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", TOKEN);
  mocks.readTtsConfig.mockReset().mockReturnValue({ enabled: true, voice: "", rate: 10, url: "http://127.0.0.1:10101" });
  mocks.writeTtsConfig.mockReset().mockReturnValue({ enabled: true, voice: "", rate: 10, url: "http://127.0.0.1:10101" });
  mocks.ttsHostCapabilities.mockReset().mockReturnValue({ hostPlatform: "linux", sapiAvailable: false });
  mocks.isSafeUnauthenticatedTtsUrl.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("/api/settings/tts", () => {
  it("marks authenticated custom URL changes as allowed for the extension", async () => {
    mocks.isSafeUnauthenticatedTtsUrl.mockReturnValue(false);
    const patchResponse = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", {
      method: "PATCH", headers: { ...authHeaders, "content-type": "application/json" }, body: JSON.stringify({ url: "http://10.0.0.5:10101" }),
    }));
    expect(patchResponse.status).toBe(200);
    expect(mocks.writeTtsConfig).toHaveBeenCalledWith(
      { url: "http://10.0.0.5:10101" },
      { allowCustomUrl: true },
    );
  });

  it("blocks unauthenticated URL changes but keeps local TTS settings usable", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
    const getResponse = await GET();
    const safePatch = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", { method: "PATCH", body: JSON.stringify({ enabled: true }) }));
    const clearUrl = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", { method: "PATCH", body: JSON.stringify({ url: "" }) }));
    mocks.isSafeUnauthenticatedTtsUrl.mockReturnValue(true);
    const localUrlPatch = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", { method: "PATCH", body: JSON.stringify({ url: "http://127.0.0.1:10101" }) }));
    mocks.isSafeUnauthenticatedTtsUrl.mockReturnValue(false);
    const unsafeLoopbackPatch = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", { method: "PATCH", body: JSON.stringify({ url: "http://127.0.0.1:18080" }) }));
    const unsafePatch = await PATCH(new NextRequest("http://lcp.test/api/settings/tts", { method: "PATCH", body: JSON.stringify({ url: "http://10.0.0.9:10101", allowCustomUrl: true }) }));
    expect(getResponse.status).toBe(200);
    expect(safePatch.status).toBe(200);
    expect(clearUrl.status).toBe(200);
    expect(localUrlPatch.status).toBe(200);
    expect(unsafeLoopbackPatch.status).toBe(401);
    expect(unsafePatch.status).toBe(401);
    expect(mocks.writeTtsConfig).toHaveBeenCalledTimes(3);
    expect(mocks.writeTtsConfig.mock.calls.map(([body]) => body)).toEqual([
      { enabled: true },
      { url: "" },
      { url: "http://127.0.0.1:10101" },
    ]);
    expect(mocks.writeTtsConfig).toHaveBeenNthCalledWith(1, { enabled: true }, { allowCustomUrl: undefined });
    expect(mocks.writeTtsConfig).toHaveBeenNthCalledWith(2, { url: "" }, { allowCustomUrl: false });
    expect(mocks.writeTtsConfig).toHaveBeenNthCalledWith(3, { url: "http://127.0.0.1:10101" }, { allowCustomUrl: false });
  });
});
