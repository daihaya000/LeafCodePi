import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => api);

import {
  getLastReadAt,
  getUnreadSnapshot,
  hasUnread,
  hydrateLastReadState,
  markRead,
  resetUnreadStateForTests,
} from "./bot-unread";

beforeEach(() => {
  vi.stubGlobal("window", {});
  api.getJson.mockReset();
  api.sendJson.mockReset();
});

afterEach(() => {
  resetUnreadStateForTests();
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

  it("hydrates server-persisted markers", async () => {
    api.getJson.mockResolvedValue({ markers: [{ kind: "bot", id: "one", readAt: 123 }] });

    await hydrateLastReadState();

    expect(getLastReadAt("bot", "one")).toBe(123);
    expect(getUnreadSnapshot()).toBe(1);
  });

  it("updates locally before persisting the newest marker", async () => {
    api.sendJson.mockResolvedValue({ readAt: 456 });

    markRead("room", "two", 456);
    markRead("room", "two", 123);
    await vi.waitFor(() => expect(api.sendJson).toHaveBeenCalledTimes(1));

    expect(getLastReadAt("room", "two")).toBe(456);
    expect(api.sendJson).toHaveBeenCalledWith(
      "/api/unread",
      { kind: "room", id: "two", readAt: 456 },
      "PUT",
    );
  });

  it("adopts a newer marker returned by the server", async () => {
    api.sendJson.mockResolvedValue({ readAt: 789 });

    markRead("task", "three", 456);
    await vi.waitFor(() => expect(getLastReadAt("task", "three")).toBe(789));
  });

  it("keeps working when the server is unavailable", async () => {
    api.sendJson.mockRejectedValue(new Error("offline"));

    markRead("task", "three", 789);
    await Promise.resolve();

    expect(getLastReadAt("task", "three")).toBe(789);
  });
});
