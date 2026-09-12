// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  readTaskTtsEnabled,
  speakable,
  speakText,
  stopSpeaking,
  subscribeTaskTtsEnabled,
  writeTaskTtsEnabled,
} from "./tts-playback";

describe("speakable", () => {
  it("Markdown記法を落として本文だけ残す", () => {
    expect(speakable("# 見出し\n[リンク](http://x) と `code` だけ。```\nblock\n```")).toBe("見出し リンク と code だけ。");
  });

  it("記号や罫線だけなら空文字を返す", () => {
    expect(speakable("---")).toBe("");
    expect(speakable("   ")).toBe("");
  });
});

describe("task tts enabled toggle", () => {
  beforeEach(() => window.localStorage.clear());

  it("既定はfalseで、書き込みを読み戻せる", () => {
    expect(readTaskTtsEnabled("task-1")).toBe(false);
    writeTaskTtsEnabled("task-1", true);
    expect(readTaskTtsEnabled("task-1")).toBe(true);
    expect(readTaskTtsEnabled("task-2")).toBe(false);
    writeTaskTtsEnabled("task-1", false);
    expect(readTaskTtsEnabled("task-1")).toBe(false);
  });

  it("書き込みが同一タブ内の購読者に通知される", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeTaskTtsEnabled("task-9", (enabled) => seen.push(enabled));
    try {
      writeTaskTtsEnabled("task-9", true);
      writeTaskTtsEnabled("other", true);
      expect(seen).toEqual([true]);
    } finally {
      unsubscribe();
    }
    writeTaskTtsEnabled("task-9", false);
    expect(seen).toEqual([true]);
  });
});

describe("speech output", () => {
  const installAudio = () => {
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const instances: { play: typeof play; pause: typeof pause }[] = [];
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null;
      play = play;
      pause = pause;
      constructor() {
        instances.push(this);
      }
    });
    return { play, pause, instances };
  };

  it("speakText は合成APIを叩いて再生する", async () => {
    const { play } = installAudio();
    const fetchMock = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      speakText("# 見出し\n本文です");
      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ text: "見出し 本文です" });
    } finally {
      stopSpeaking();
      vi.unstubAllGlobals();
    }
  });

  it("読むものが無ければ何もしない", () => {
    installAudio();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      speakText("---");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("合成失敗は onError に日本語メッセージを返す（フォールバックなし）", async () => {
    installAudio();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "合成エンジンが未設定です" }), { status: 400 })));
    try {
      const errors: string[] = [];
      speakText("こんにちは", { onError: (message) => errors.push(message) });
      await vi.waitFor(() => expect(errors).toEqual(["合成エンジンが未設定です"]));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
