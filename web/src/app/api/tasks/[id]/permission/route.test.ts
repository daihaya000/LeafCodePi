import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  respondToPermissionPrompt: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/permission", () => {
  beforeEach(() => {
    mocks.respondToPermissionPrompt.mockReset();
    mocks.respondToPermissionPrompt.mockReturnValue(true);
  });

  it("rejects a non-string request id before responding", async () => {
    const response = await POST(
      request({ requestId: 123, approved: true }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.respondToPermissionPrompt).not.toHaveBeenCalled();
  });
});
