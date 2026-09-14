import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  answerProviderLogin: vi.fn(),
  cancelProviderLogin: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/providers/anthropic/login/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/[id]/login/answer", () => {
  beforeEach(() => {
    mocks.answerProviderLogin.mockReset();
  });

  it("rejects a non-string prompt id before answering", async () => {
    const response = await POST(request({ promptId: 123, value: "answer" }));

    expect(response.status).toBe(400);
    expect(mocks.answerProviderLogin).not.toHaveBeenCalled();
  });

  it("rejects a missing sessionId before answering", async () => {
    const response = await POST(request({ promptId: "p1", value: "answer" }));

    expect(response.status).toBe(400);
    expect(mocks.answerProviderLogin).not.toHaveBeenCalled();
  });

  it("forwards sessionId when answering", async () => {
    mocks.answerProviderLogin.mockReturnValue(undefined);
    const response = await POST(
      request({ promptId: "p1", value: "answer", sessionId: "sess-1" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.answerProviderLogin).toHaveBeenCalledWith("p1", "answer", "sess-1");
  });
});