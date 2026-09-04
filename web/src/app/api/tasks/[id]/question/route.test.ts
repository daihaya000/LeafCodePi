import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  respondToQuestionPrompt: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/question", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/question", () => {
  beforeEach(() => {
    mocks.respondToQuestionPrompt.mockReset();
    mocks.respondToQuestionPrompt.mockReturnValue(true);
  });

  it("rejects a non-string request id before responding", async () => {
    const response = await POST(
      request({ requestId: 123, reject: true }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.respondToQuestionPrompt).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean reject flag before responding", async () => {
    const response = await POST(
      request({ requestId: "request-1", reject: "false", answers: [["Yes"]] }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.respondToQuestionPrompt).not.toHaveBeenCalled();
  });
});
