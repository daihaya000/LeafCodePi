import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot, patchBot } from "@/lib/bots";
import { writeTtsConfig } from "@/lib/tts-config";
import { POST } from "@backend-runtime/json-business/handlers/tts/synthesize/route";

const WEBUI_TOKEN = "tts-synthesis-webui-token";

function request(text: unknown, botId?: string, token?: string): NextRequest {
  return new NextRequest("http://localhost/api/tts/synthesize", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify({ text, ...(botId ? { botId } : {}) }),
  });
}

describe("POST /api/tts/synthesize", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-tts-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("全体が無効なら合成せず400", async () => {
    writeTtsConfig({ enabled: false, url: "http://127.0.0.1:10101" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request("こんにちは"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("全体") });
  });

  it("全体が有効ならエンジンの音声を返す", async () => {
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:10101", voice: "1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("audio_query")
          ? new Response(JSON.stringify({}), { status: 200 })
          : new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } }),
      ),
    );
    const response = await POST(request("こんにちは"));
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("BotごとのTTS音声をグローバル音声より優先してOpenAI互換エンジンへ渡す", async () => {
    const bot = createBot({ name: "TTS bot" });
    patchBot(bot.id, { ttsVoice: "1257529344" });
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:18080/v1/audio/speech", voice: "871574624" });
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", WEBUI_TOKEN);
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
    }));
    const response = await POST(request("こんにちは", bot.id, WEBUI_TOKEN));
    expect(response.status).toBe(200);
    expect(JSON.parse(sentBody)).toMatchObject({ model: "tts-1", voice: "1257529344", input: "こんにちは" });
  });

  it("Botに音声指定がなければグローバル音声を使う", async () => {
    const bot = createBot({ name: "TTS bot" });
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:18080/v1/audio/speech", voice: "871574624" });
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", WEBUI_TOKEN);
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
    }));
    const response = await POST(request("こんにちは", bot.id, WEBUI_TOKEN));
    expect(response.status).toBe(200);
    expect(JSON.parse(sentBody)).toMatchObject({ voice: "871574624" });
  });

  it("requires WebUI auth before contacting non-default TTS targets", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:18080/v1/audio/speech" });
    const deniedLoopback = await POST(request("こんにちは"));
    expect(deniedLoopback.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    writeTtsConfig({ enabled: true, url: "http://10.0.0.8:18080/v1/audio/speech" });
    const deniedRemote = await POST(request("こんにちは"));
    expect(deniedRemote.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", WEBUI_TOKEN);
    const allowed = await POST(request("こんにちは", undefined, WEBUI_TOKEN));
    expect(allowed.status).toBe(200);
  });

  it("空文は400", async () => {
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:10101" });
    const response = await POST(request("  "));
    expect(response.status).toBe(400);
  });
});
