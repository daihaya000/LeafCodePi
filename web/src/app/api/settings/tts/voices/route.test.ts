import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readTtsConfig: vi.fn(),
}));

vi.mock("@/lib/tts-config", () => ({ readTtsConfig: mocks.readTtsConfig }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readTtsConfig.mockReturnValue({
    enabled: false,
    voice: "",
    rate: 10,
    url: "http://127.0.0.1:10101",
  });
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

    const response = await GET();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:10101/speakers",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(await response.json()).toEqual({
      voices: [{ id: "2000000001", label: "追加モデル / ノーマル" }],
    });
    vi.unstubAllGlobals();
  });

  it("does not contact an engine when AivisSpeech is not selected", async () => {
    mocks.readTtsConfig.mockReturnValue({ enabled: false, voice: "", rate: 10, url: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voices: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
