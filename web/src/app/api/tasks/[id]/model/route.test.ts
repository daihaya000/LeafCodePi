import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setTaskModel: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/model", () => {
  beforeEach(() => {
    mocks.setTaskModel.mockReset();
    mocks.setTaskModel.mockResolvedValue({ id: "task-1" });
  });

  it("rejects a non-string model before calling the harness", async () => {
    const response = await POST(
      request({ model: 123 }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.setTaskModel).not.toHaveBeenCalled();
  });
});
