import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeTts, TTS_MAX_AUDIO_BYTES, TtsSynthesizeError } from "./tts-synthesize";

afterEach(() => vi.unstubAllGlobals());

describe("synthesizeTts limits", () => {
  it("passes a timeout signal to the engine request", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesizeTts("こんにちは", "http://engine.test/v1/tts", "");
    expect([...result.audio]).toEqual([1, 2, 3]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an oversized declared Content-Length without buffering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new Uint8Array(4), { headers: { "content-length": String(TTS_MAX_AUDIO_BYTES + 1) } })));
    await expect(synthesizeTts("a", "http://engine.test/v1/tts", "")).rejects.toBeInstanceOf(TtsSynthesizeError);
  });

  it("stops reading a stream that exceeds the cap", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 20) controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(synthesizeTts("a", "http://engine.test/v1/tts", "")).rejects.toThrow(/大きすぎ/);
    expect(sent).toBeLessThan(20);
  });
});
