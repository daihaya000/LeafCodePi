import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readTtsConfig: vi.fn(),
  isSafeUnauthenticatedTtsUrl: vi.fn(),
}));

vi.mock("@/lib/tts-config", () => ({
  readTtsConfig: mocks.readTtsConfig,
  isSafeUnauthenticatedTtsUrl: mocks.isSafeUnauthenticatedTtsUrl,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
  vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
  mocks.isSafeUnauthenticatedTtsUrl.mockReturnValue(true);
  mocks.readTtsConfig.mockReturnValue({
    enabled: false,
    voice: "",
    rate: 10,
    url: "http://127.0.0.1:10101",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/settings/tts/voices", () => {
  it("maps installed AivisSpeech talk styles to dropdown options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            name: "追加モデル",
            styles: [
              { id: 2000000001, name: "ノーマル", type: "talk" },
              { id: 2000000002, name: "歌", type: "sing" },
            ],
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://lcp.test/api/settings/tts/voices"));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:10101/speakers",
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
    expect(await response.json()).toEqual({
      voices: [{ id: "2000000001", label: "追加モデル / ノーマル" }],
    });
  });

  it("does not contact an engine when AivisSpeech is not selected", async () => {
    mocks.readTtsConfig.mockReturnValue({ enabled: false, voice: "", rate: 10, url: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://lcp.test/api/settings/tts/voices"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voices: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires WebUI auth before a non-default AivisSpeech probe", async () => {
    mocks.isSafeUnauthenticatedTtsUrl.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://lcp.test/api/settings/tts/voices");
    const denied = await GET(request);
    expect(denied.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "tts-voices-webui-token");
    const allowed = await GET(new Request(request.url, { headers: { authorization: "Bearer tts-voices-webui-token" } }));
    expect(allowed.status).toBe(200);
  });
});
