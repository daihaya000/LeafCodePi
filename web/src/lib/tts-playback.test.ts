// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  clampPlaybackRate,
  clampPlaybackVolume,
  readPlaybackRate,
  readPlaybackVolume,
  readTaskTtsEnabled,
  speakable,
  speakText,
  stopSpeaking,
  subscribeTaskTtsEnabled,
  writePlaybackRate,
  writePlaybackVolume,
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

describe("playback rate/volume", () => {
  beforeEach(() => window.localStorage.clear());

  it("既定は1倍・100%で範囲外は丸める", () => {
    expect(readPlaybackRate()).toBe(1);
    expect(readPlaybackVolume()).toBe(100);
    expect(writePlaybackRate(9)).toBe(2);
    expect(writePlaybackRate(0)).toBe(0.5);
    expect(writePlaybackVolume(150)).toBe(100);
    expect(writePlaybackVolume(-5)).toBe(0);
    expect(readPlaybackRate()).toBe(0.5);
    expect(readPlaybackVolume()).toBe(0);
    expect(clampPlaybackRate(Number.NaN)).toBe(1);
    expect(clampPlaybackVolume(Number.NaN)).toBe(100);
  });
});

describe("speech output", () => {
  const installAudio = () => {
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const instances: { playbackRate: number; volume: number }[] = [];
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null;
      playbackRate = 1;
      volume = 1;
      play = play;
      pause = pause;
      constructor() {
        instances.push(this);
      }
    });
    return { play, pause, instances };
  };

  it("speakText は合成APIを叩いて再生する", async () => {
    const { play, instances } = installAudio();
    const fetchMock = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      writePlaybackRate(1.5);
      writePlaybackVolume(50);
      speakText("# 見出し\n本文です");
      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ text: "見出し 本文です" });
      expect(instances[0]).toMatchObject({ playbackRate: 1.5, volume: 0.5 });
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
