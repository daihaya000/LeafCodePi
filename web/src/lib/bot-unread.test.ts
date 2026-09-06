import { describe, expect, it } from "vitest";
import { hasUnread } from "./bot-unread";

describe("bot unread timestamps", () => {
  it("reports a message newer than the last-read marker", () => {
    expect(hasUnread("2026-09-07T00:00:02.000Z", Date.parse("2026-09-07T00:00:01.000Z"))).toBe(true);
    expect(hasUnread("2026-09-07T00:00:01.000Z", Date.parse("2026-09-07T00:00:01.000Z"))).toBe(false);
  });

  it("does not report missing or invalid message timestamps", () => {
    expect(hasUnread(null, null)).toBe(false);
    expect(hasUnread("not-a-date", null)).toBe(false);
  });
});
