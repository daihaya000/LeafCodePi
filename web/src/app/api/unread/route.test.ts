import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const unread = vi.hoisted(() => ({
  getUnreadReadMarkers: vi.fn(),
  markUnreadRead: vi.fn(),
}));

vi.mock("@/lib/unread-state", () => unread);

import { GET, PUT } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/unread", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/unread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns persisted read markers", async () => {
    unread.getUnreadReadMarkers.mockReturnValue([{ kind: "bot", id: "bot-1", readAt: 123 }]);

    const response = GET();

    expect(await response.json()).toEqual({ markers: [{ kind: "bot", id: "bot-1", readAt: 123 }] });
  });

  it("persists a valid marker", async () => {
    unread.markUnreadRead.mockReturnValue(456);

    const response = await PUT(request({ kind: "task", id: "task-1", readAt: 456 }));

    expect(response.status).toBe(200);
    expect(unread.markUnreadRead).toHaveBeenCalledWith("task", "task-1", 456);
    expect(await response.json()).toEqual({ readAt: 456 });
  });

  it("rejects malformed markers", async () => {
    unread.markUnreadRead.mockReturnValue(null);

    const response = await PUT(request({ kind: "other", id: "task-1", readAt: 456 }));

    expect(response.status).toBe(400);
  });
});
