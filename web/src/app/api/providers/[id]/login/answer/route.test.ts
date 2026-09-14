import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  answerProviderLogin: vi.fn(),
  cancelProviderLogin: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status:
      typeof error === "object" &&
      error &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { DELETE, POST } from "./route";

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
    mocks.cancelProviderLogin.mockReset();
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

describe("DELETE /api/providers/[id]/login/answer", () => {
  beforeEach(() => {
    mocks.cancelProviderLogin.mockReset();
    mocks.jsonError.mockClear();
  });

  it("rejects cancel without sessionId", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/providers/anthropic/login/answer", {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.cancelProviderLogin).not.toHaveBeenCalled();
  });

  it("forwards sessionId from the query string", async () => {
    mocks.cancelProviderLogin.mockReturnValue(undefined);
    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/providers/anthropic/login/answer?sessionId=sess-9",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.cancelProviderLogin).toHaveBeenCalledWith("sess-9");
  });

  it("returns 409 when the session does not match", async () => {
    mocks.cancelProviderLogin.mockImplementation(() => {
      throw Object.assign(new Error("ログインセッションが一致しません"), { status: 409 });
    });
    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/providers/anthropic/login/answer?sessionId=other",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(409);
  });
});
