import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeTts, TtsSynthesizeError } from "./tts-synthesize";

afterEach(() => vi.unstubAllGlobals());

function wavResponse(): Response {
  return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
}

describe("synthesizeTts", () => {
  it("url未設定は400エラー（フォールバックなし）", async () => {
    await expect(synthesizeTts("こんにちは", "", "")).rejects.toMatchObject({ status: 400 });
  });

  it("空文は400エラー", async () => {
    await expect(synthesizeTts("  ", "http://127.0.0.1:10101", "1")).rejects.toMatchObject({ status: 400 });
  });

  it("パス無しURLはVOICEVOX系（audio_query→synthesis）で合成する", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("audio_query") ? new Response(JSON.stringify({}), { status: 200 }) : wavResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesizeTts("こんにちは", "http://127.0.0.1:10101", "1878365379");
    expect(result.contentType).toBe("audio/wav");
    expect(result.audio.length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("/v1/audio/speech は未指定なら既定モデル tts-1 を使う", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return wavResponse();
    }));
    await synthesizeTts("はい", "http://127.0.0.1:18080/v1/audio/speech", "ryan");
    expect(JSON.parse(sentBody)).toMatchObject({ model: "tts-1", input: "はい", voice: "ryan" });
  });

  it("/v1/audio/speech はOpenAI互換ボディで1回POSTする", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return wavResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeTts("はい", "http://127.0.0.1:18080/v1/audio/speech", "ryan", "local-tts");
    expect(JSON.parse(sentBody)).toMatchObject({ model: "local-tts", input: "はい", voice: "ryan" });
  });

  it("エンジン停止中は接続エラー", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(synthesizeTts("はい", "http://127.0.0.1:10101", "1")).rejects.toBeInstanceOf(TtsSynthesizeError);
  });

  it("エンジンのエラーステータスをそのまま投げる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ng", { status: 500 })));
    await expect(synthesizeTts("はい", "http://127.0.0.1:9999/tts", "")).rejects.toMatchObject({ status: 502 });
  });
});
