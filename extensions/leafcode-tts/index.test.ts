import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHttpTtsBody, cut, isVoicevoxEngineUrl, readBotTtsVoice, readTtsConfig, speakable, Speaker, SpeechChunker, synthesizeVoicevox, writeTtsConfig } from "./index.ts";

afterEach(() => vi.unstubAllGlobals());

/** Speaker.say と同じ前処理を通した結果だけを読み上げ単位として比較する。 */
function spoken(chunker: SpeechChunker, delta: string): string[] {
  return chunker.push(delta).map(speakable).filter((text) => text.length > 0);
}

describe("cut", () => {
  it("句点・感嘆符・改行で必ず区切る", () => {
    expect(cut("はい。いいえ！なぜ？\n続き").chunks).toEqual(["はい。", "いいえ！", "なぜ？", "\n"]);
  });

  it("読点は最小長を超えたときだけ区切る", () => {
    expect(cut("あ、い、う、").chunks).toEqual([]);
    expect(cut("このエラーについてですが、次の行").chunks).toEqual(["このエラーについてですが、"]);
  });

  it("ASCII のピリオドでは区切らない（index.ts や 3.14 を割らない）", () => {
    expect(cut("index.ts and 3.14 here").chunks).toEqual([]);
  });

  it("句読点が来なくても上限で打ち切る", () => {
    const { chunks, rest } = cut("あ".repeat(200));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(90);
    expect(rest).toHaveLength(20);
  });

  it("区切れない残りを rest で返す", () => {
    expect(cut("途中まで。まだ続く")).toEqual({ chunks: ["途中まで。"], rest: "まだ続く" });
  });
});

describe("speakable", () => {
  it("Markdown 記法と URL を落とす", () => {
    expect(speakable("## **太字**の`code`と[リンク](https://example.com)")).toBe("太字のcodeとリンク");
    expect(speakable("- 箇条書き https://example.com/x です")).toBe("箇条書き です");
  });

  it("読み上げるものが無ければ空文字", () => {
    expect(speakable("|---|---|")).toBe("");
    expect(speakable("\n")).toBe("");
  });
});

describe("SpeechChunker", () => {
  it("streaming の delta を句読点単位で流す", () => {
    const chunker = new SpeechChunker();
    expect(spoken(chunker, "このエラーについてですが、")).toEqual(["このエラーについてですが、"]);
    expect(spoken(chunker, "Maya側のPython環境を見る")).toEqual([]);
    expect(spoken(chunker, "限り、subprocess")).toEqual(["Maya側のPython環境を見る限り、"]);
    expect(chunker.flush().map(speakable).filter(Boolean)).toEqual(["subprocess"]);
  });

  it("コードブロックは読まない", () => {
    const chunker = new SpeechChunker();
    expect(spoken(chunker, "説明します。\n```ts\nconst a = 1;\n```\n終わりです。")).toEqual([
      "説明します。",
      "終わりです。",
    ]);
  });

  it("delta をまたいで分割されたフェンスも読まない", () => {
    const chunker = new SpeechChunker();
    expect(spoken(chunker, "説明します。\n``")).toEqual(["説明します。"]);
    expect(spoken(chunker, "`ts\nconst a = 1;\n")).toEqual([]);
    expect(spoken(chunker, "```\n終わりです。")).toEqual(["終わりです。"]);
  });

  it("閉じていないコードブロックを flush で漏らさない", () => {
    const chunker = new SpeechChunker();
    spoken(chunker, "見てください。\n```ts\nconst a = 1;");
    expect(chunker.flush()).toEqual([]);
  });

  it("reset で読みかけを捨てる", () => {
    const chunker = new SpeechChunker();
    spoken(chunker, "途中まで");
    chunker.reset();
    expect(chunker.flush()).toEqual([]);
  });
});

describe("readBotTtsVoice", () => {
  it("Bot workspace の設定を読み、未指定や別workspaceは未指定にする", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-bot-tts-"));
    const id = "12345678-1234-1234-1234-123456789abc";
    const workspace = join(root, "bots", id, "workspace");
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(root, "bots", id, "config.json"), JSON.stringify({ id, ttsVoice: " 1257529344 " }), "utf8");
      expect(readBotTtsVoice(workspace, root)).toBe("1257529344");
      writeFileSync(join(root, "bots", id, "config.json"), JSON.stringify({ id, ttsVoice: " " }), "utf8");
      expect(readBotTtsVoice(workspace, root)).toBeUndefined();
      expect(readBotTtsVoice(join(root, "project"), root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readTtsConfig", () => {
  it("ファイルが無ければ既定は無効", () => {
    expect(readTtsConfig(join(tmpdir(), "leafcode-tts-missing.json"))).toEqual({
      enabled: false,
      rate: 10,
      voice: undefined,
      url: undefined,
    });
  });

  it("rate を -10..10 に丸め、空文字は未指定として扱う", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-tts-"));
    const file = join(dir, "tts.json");
    try {
      writeFileSync(file, JSON.stringify({ enabled: true, rate: 99, voice: "  ", url: "http://127.0.0.1:8080/tts" }));
      expect(readTtsConfig(file)).toEqual({
        enabled: true,
        rate: 10,
        voice: undefined,
        url: "http://127.0.0.1:8080/tts",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeTtsConfig", () => {
  it("preserves the explicit custom-URL opt-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-tts-"));
    const file = join(dir, "tts.json");
    try {
      writeTtsConfig({ enabled: true, rate: 10, url: "http://192.168.1.8:18080/tts", allowCustomUrl: true }, file);
      expect(readTtsConfig(file).allowCustomUrl).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/tts の enabled を読み戻せる形で保存する", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-tts-"));
    const file = join(dir, "nested", "tts.json");
    try {
      writeTtsConfig(
        { enabled: true, rate: 2, voice: "Microsoft Haruka Desktop", url: "http://127.0.0.1:8080/tts" },
        file,
      );
      expect(readTtsConfig(file)).toEqual({
        enabled: true,
        rate: 2,
        voice: "Microsoft Haruka Desktop",
        url: "http://127.0.0.1:8080/tts",
      });
      writeTtsConfig({ enabled: false, rate: 0 }, file);
      expect(readTtsConfig(file)).toEqual({
        enabled: false,
        rate: 0,
        voice: undefined,
        url: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHttpTtsBody", () => {
  it("OpenAI 互換パスは input/voice/response_format を送る", () => {
    expect(JSON.parse(buildHttpTtsBody("http://127.0.0.1:8080/v1/audio/speech", "こんにちは", "ryan"))).toEqual({
      model: "tts-1",
      input: "こんにちは",
      voice: "ryan",
      response_format: "wav",
    });
  });

  it("/v1/tts は text/speaker、素の /tts は text/voice", () => {
    expect(JSON.parse(buildHttpTtsBody("http://127.0.0.1:8080/v1/tts", "はい", "vivian"))).toEqual({
      text: "はい",
      language: "Japanese",
      speaker: "vivian",
      voice: "vivian",
    });
    expect(JSON.parse(buildHttpTtsBody("http://127.0.0.1:8080/tts", "はい", "haruka"))).toEqual({
      text: "はい",
      voice: "haruka",
    });
  });
});

describe("isVoicevoxEngineUrl", () => {
  it("パス無しのエンジン URL だけ true", () => {
    expect(isVoicevoxEngineUrl("http://127.0.0.1:10101")).toBe(true);
    expect(isVoicevoxEngineUrl("http://127.0.0.1:10101/")).toBe(true);
    expect(isVoicevoxEngineUrl("http://127.0.0.1:18080/v1/audio/speech")).toBe(false);
    expect(isVoicevoxEngineUrl("http://127.0.0.1:8080/v1/tts")).toBe(false);
  });
});

describe("extension TTS outbound", () => {
  it("does not follow redirects for VOICEVOX requests", async () => {
    const options: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      options.push(init);
      return options.length === 1
        ? new Response("{}", { status: 200 })
        : new Response(Buffer.from([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const audio = await synthesizeVoicevox("http://127.0.0.1:10101", "こんにちは", "1");

    expect(audio?.length).toBe(3);
    expect(options).toHaveLength(2);
    expect(options.every((init) => init.redirect === "error")).toBe(true);
  });

  it("rejects unsupported schemes and URL credentials before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const speaker = new Speaker({ enabled: true, rate: 10 });
    const synthesize = (speaker as unknown as { synthesize(text: string, url: string): Promise<string | null> })
      .synthesize.bind(speaker);

    expect(await synthesize("text", "file:///private/data")).toBeNull();
    expect(await synthesizeVoicevox("http://user:secret@127.0.0.1:10101", "text")).toBeNull();
    expect(await synthesizeVoicevox("http://192.168.1.8:50021", "text")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit custom-URL opt-in and does not follow redirects", async () => {
    const endpoint = "http://192.168.1.8:18080/v1/audio/speech";
    const options: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      options.push(init);
      return new Response(Buffer.from([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const untrustedSpeaker = new Speaker({ enabled: true, rate: 10, url: endpoint });
    const denied = await (untrustedSpeaker as unknown as { synthesize(text: string, url: string): Promise<string | null> })
      .synthesize("text", endpoint);
    expect(denied).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const speaker = new Speaker({ enabled: true, rate: 10, url: endpoint, allowCustomUrl: true });
    const synthesize = (speaker as unknown as { synthesize(text: string, url: string): Promise<string | null> })
      .synthesize.bind(speaker);
    const file = await synthesize("text", endpoint);
    try {
      expect(file).toBeTruthy();
      expect(options).toHaveLength(1);
      expect(options[0]?.redirect).toBe("error");
    } finally {
      if (file) rmSync(file, { force: true });
    }
  });
});

describe("Speaker temp wav cleanup", () => {
  it("removes the synthesized wav after playback and on stop", async () => {
    const endpoint = "http://192.168.1.8:18080/v1/audio/speech";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 })));
    const speaker = new Speaker({ enabled: true, rate: 10, url: endpoint, allowCustomUrl: true });
    const internals = speaker as unknown as {
      synthesize(text: string, url: string): Promise<string | null>;
      removeSynthFile(body: string): void;
      playingFile: string | null;
    };

    const clip = await internals.synthesize("text", endpoint);
    expect(clip).toBeTruthy();
    expect(existsSync(clip!)).toBe(true);

    // The pump keeps the clip until playback reports completion, because the
    // worker still holds the file while it plays.
    internals.playingFile = clip;
    internals.removeSynthFile(internals.playingFile);
    expect(existsSync(clip!)).toBe(false);

    // stop() clears a clip that is still playing.
    const playing = await internals.synthesize("text", endpoint);
    internals.playingFile = playing;
    speaker.stop();
    expect(existsSync(playing!)).toBe(false);

    // A path that is not this process's temp clip is never deleted.
    const foreign = join(tmpdir(), "not-a-tts-clip.wav");
    writeFileSync(foreign, "x", "utf8");
    internals.removeSynthFile(foreign);
    expect(existsSync(foreign)).toBe(true);
    rmSync(foreign, { force: true });
    speaker.dispose();
  });
});

describe("Speaker synthesis concurrency", () => {
  it("keeps at most four syntheses in flight and still finishes the queue", async () => {
    const endpoint = "http://192.168.1.8:18080/v1/audio/speech";
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(Buffer.from([1, 2, 3]), { status: 200 });
    }));
    const speaker = new Speaker({ enabled: true, rate: 10, url: endpoint, allowCustomUrl: true });
    const internals = speaker as unknown as { synthesizeQueued(text: string, url: string): Promise<string | null> };

    const files = await Promise.all(
      Array.from({ length: 12 }, (_, index) => internals.synthesizeQueued(`chunk ${index}`, endpoint)),
    );

    expect(files.every(Boolean)).toBe(true);
    // The queue is bounded, but nothing is dropped.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    for (const file of files) if (file) rmSync(file, { force: true });
    speaker.dispose();
  });

  it("releases queued syntheses when the speaker is disposed", async () => {
    const endpoint = "http://192.168.1.8:18080/v1/audio/speech";
    let inFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(Buffer.from([1, 2, 3]), { status: 200 });
    }));
    const speaker = new Speaker({ enabled: true, rate: 10, url: endpoint, allowCustomUrl: true });
    const internals = speaker as unknown as { synthesizeQueued(text: string, url: string): Promise<string | null> };

    const pending = Array.from({ length: 10 }, (_, index) => internals.synthesizeQueued(`chunk ${index}`, endpoint));
    speaker.dispose();
    const files = await Promise.all(pending);

    // Disposed speakers must not hang: every waiter settles.
    expect(files.every((file) => file === null || typeof file === "string")).toBe(true);
    for (const file of files) if (file) rmSync(file, { force: true });
  });
});
