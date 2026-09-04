import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  revertTask: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/revert", () => {
  beforeEach(() => {
    mocks.revertTask.mockReset();
    mocks.revertTask.mockResolvedValue({ task: { id: "task-1" } });
  });

  it("rejects a non-string entry id before reverting", async () => {
    const response = await POST(
      request({ entryId: 123 }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.revertTask).not.toHaveBeenCalled();
  });
});
