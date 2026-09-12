// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { readTaskTtsEnabled, speakable, writeTaskTtsEnabled } from "./tts-playback";

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
});
