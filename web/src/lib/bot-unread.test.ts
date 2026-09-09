import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastReadAt, hasUnread, markRead } from "./bot-unread";

function stubStorage(getItem: ReturnType<typeof vi.fn>, setItem?: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("window", {
    localStorage: {
      getItem,
      setItem: setItem ?? vi.fn(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bot unread timestamps", () => {
  it("reports a message newer than the last-read marker", () => {
    expect(hasUnread("2026-09-07T00:00:02.000Z", Date.parse("2026-09-07T00:00:01.000Z"))).toBe(true);
    expect(hasUnread("2026-09-07T00:00:01.000Z", Date.parse("2026-09-07T00:00:01.000Z"))).toBe(false);
  });

  it("does not report missing or invalid message timestamps", () => {
    expect(hasUnread(null, null)).toBe(false);
    expect(hasUnread("not-a-date", null)).toBe(false);
  });

  it("reads and writes the last-read marker", () => {
    const getItem = vi.fn((key: string) =>
      key === "webui.bot.last_read.bot.one" ? "123" : null,
    );
    const setItem = vi.fn(() => undefined);
    stubStorage(getItem, setItem);
    expect(getLastReadAt("bot", "one")).toBe(123);
    markRead("bot", "one", 456);
    expect(setItem).toHaveBeenCalledWith("webui.bot.last_read.bot.one", "456");
    // 既読位置が新しい場合は書き換えない
    markRead("room", "two", 100);
    expect(setItem).toHaveBeenCalledWith("webui.bot.last_read.room.two", "100");
  });

  it("returns null when localStorage reads throw", () => {
    stubStorage(
      vi.fn(() => {
        throw new Error("storage blocked");
      }),
    );
    expect(getLastReadAt("bot", "one")).toBeNull();
  });

  it("does not throw when localStorage writes are blocked", () => {
    stubStorage(
      vi.fn(() => null),
      vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    );
    expect(() => markRead("bot", "one", 123)).not.toThrow();
  });

  it("ignores invalid stored markers", () => {
    stubStorage(vi.fn(() => "not-a-number"));
    expect(getLastReadAt("room", "two")).toBeNull();
  });
});