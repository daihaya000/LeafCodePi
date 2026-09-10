import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  revertTask: vi.fn(),
  cancelBotCodeRequests: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  })),
}));

vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot, botTaskId: (id: string) => `bot:${id}` }));
vi.mock("@/lib/pi/harness", () => ({ revertTask: mocks.revertTask, jsonError: mocks.jsonError }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ cancelBotCodeRequests: mocks.cancelBotCodeRequests }));

import { POST } from "./route";

function request(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bots/bot-1/revert", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBot.mockReturnValue({ id: "bot-1" });
  mocks.revertTask.mockResolvedValue({ task: { id: "bot:bot-1" }, text: "戻した", images: [] });
  mocks.cancelBotCodeRequests.mockResolvedValue(0);
});

describe("Bot conversation revert", () => {
  it("stops the outstanding Code jobs of the discarded conversation", async () => {
    mocks.cancelBotCodeRequests.mockResolvedValue(2);

    const response = await POST(request({ entryId: "entry-1" }), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "戻した", cancelledCodeRequests: 2 });
    expect(mocks.revertTask).toHaveBeenCalledWith("bot:bot-1", "entry-1");
    expect(mocks.cancelBotCodeRequests).toHaveBeenCalledWith("bot-1");
  });

  it("requires an entry id and an existing Bot", async () => {
    const missing = await POST(request({}), { params: Promise.resolve({ id: "bot-1" }) });
    expect(missing.status).toBe(400);

    mocks.getBot.mockReturnValue(undefined);
    const unknown = await POST(request({ entryId: "entry-1" }), { params: Promise.resolve({ id: "bot-1" }) });
    expect(unknown.status).toBe(404);
    expect(mocks.cancelBotCodeRequests).not.toHaveBeenCalled();
  });
});
