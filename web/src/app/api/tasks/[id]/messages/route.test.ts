import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, UiMessage } from "@/lib/types";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

function message(id: string, createdAt = 1): UiMessage {
  return {
    id,
    role: "user",
    createdAt,
    parts: [{ id: `${id}:text`, type: "text", text: id }],
  };
}

describe("/api/tasks/[id]/messages", () => {
  beforeEach(() => {
    mocks.getTaskDetail.mockReset();
    mocks.jsonError.mockClear();
  });

  it("returns the page before the cursor", async () => {
    const messages = Array.from({ length: 52 }, (_, index) => message(`m${index + 1}`, index));
    mocks.getTaskDetail.mockResolvedValue({ messages } as TaskDetail);

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=m52"),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: messages.slice(1, 51),
      messageHistory: { hasMore: true, nextCursor: "m2" },
    });
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1");
  });

  it("rejects an empty or unknown cursor", async () => {
    const empty = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=%20"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(empty.status).toBe(400);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();

    mocks.getTaskDetail.mockResolvedValue({ messages: [message("m1")] } as TaskDetail);
    const unknown = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=missing"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "履歴カーソルが無効です" });
  });
});
