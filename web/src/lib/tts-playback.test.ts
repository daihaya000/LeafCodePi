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
  const installSpeech = () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; constructor(text: string) { this.text = text; } });
    Object.defineProperty(window, "speechSynthesis", { value: { speak, cancel }, configurable: true });
    return { speak, cancel };
  };

  it("speakText は整形文を1回だけ読む", () => {
    const { speak } = installSpeech();
    speakText("# 見出し\n本文です");
    expect(speak).toHaveBeenCalledTimes(1);
    speakText("---");
    expect(speak).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("stopSpeaking はキューをキャンセルする", () => {
    const { cancel } = installSpeech();
    stopSpeaking();
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("speechSynthesis が無ければ何もしない", () => {
    vi.unstubAllGlobals();
    expect(() => speakText("こんにちは")).not.toThrow();
    expect(() => stopSpeaking()).not.toThrow();
  });
});
