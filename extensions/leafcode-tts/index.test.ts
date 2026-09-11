import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHttpTtsBody, cut, isVoicevoxEngineUrl, readTtsConfig, speakable, SpeechChunker, writeTtsConfig } from "./index.ts";

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

describe("readTtsConfig", () => {
  it("ファイルが無ければ既定は無効", () => {
    expect(readTtsConfig(join(tmpdir(), "leafcode-tts-missing.json"))).toEqual({
      enabled: false,
      rate: 0,
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
