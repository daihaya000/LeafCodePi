import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotIntercomInboxDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  getBotIntercomInbox: vi.fn(),
  markBotIntercomInboxRead: vi.fn(),
}));

vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/bot-intercom", () => ({
  getBotIntercomInbox: mocks.getBotIntercomInbox,
  markBotIntercomInboxRead: mocks.markBotIntercomInboxRead,
}));

import { GET, PATCH } from "./route";

const emptyInbox: BotIntercomInboxDto = { messages: [], unreadCount: 0, preview: null, pendingAsks: [] };
const params = { params: Promise.resolve({ id: "one" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBot.mockReturnValue({ id: "one" });
  mocks.getBotIntercomInbox.mockReturnValue(emptyInbox);
  mocks.markBotIntercomInboxRead.mockReturnValue({ ...emptyInbox, unreadCount: 0 });
});

describe("GET /api/bots/[id]/intercom", () => {
  it("returns the 1:1 inbox or 404", async () => {
    const found = await GET(new Request("http://localhost") as NextRequest, params);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ inbox: emptyInbox });
    expect(mocks.getBotIntercomInbox).toHaveBeenCalledWith("one");

    mocks.getBot.mockReturnValue(undefined);
    const missing = await GET(new Request("http://localhost") as NextRequest, params);
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/bots/[id]/intercom", () => {
  it("marks the inbox read", async () => {
    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read" }),
      }) as NextRequest,
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.markBotIntercomInboxRead).toHaveBeenCalledWith("one");
  });

  it("rejects unknown actions", async () => {
    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ask" }),
      }) as NextRequest,
      params,
    );
    expect(response.status).toBe(400);
    expect(mocks.markBotIntercomInboxRead).not.toHaveBeenCalled();
  });
});
