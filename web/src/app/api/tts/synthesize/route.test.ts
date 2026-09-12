import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot, patchBot } from "@/lib/bots";
import { writeTtsConfig } from "@/lib/tts-config";
import { POST } from "./route";

function request(text: unknown, botId?: string): NextRequest {
  return new NextRequest("http://localhost/api/tts/synthesize", {
    method: "POST",
    body: JSON.stringify({ text, ...(botId ? { botId } : {}) }),
  });
}

describe("POST /api/tts/synthesize", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-tts-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
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
    expect(response.headers.get("content-type")).toBe("audio/wav");
  });

  it("BotごとのTTSモデルをOpenAI互換エンジンへ渡す", async () => {
    const bot = createBot({ name: "TTS bot" });
    patchBot(bot.id, { ttsModel: "local-tts" });
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:18080/v1/audio/speech" });
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
    }));
    const response = await POST(request("こんにちは", bot.id));
    expect(response.status).toBe(200);
    expect(JSON.parse(sentBody)).toMatchObject({ model: "local-tts", input: "こんにちは" });
  });

  it("空文は400", async () => {
    writeTtsConfig({ enabled: true, url: "http://127.0.0.1:10101" });
    const response = await POST(request("  "));
    expect(response.status).toBe(400);
  });
});
