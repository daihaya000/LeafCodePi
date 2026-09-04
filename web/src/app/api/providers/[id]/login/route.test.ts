import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  startProviderLogin: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/providers/anthropic/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/[id]/login", () => {
  beforeEach(() => {
    mocks.startProviderLogin.mockReset();
    mocks.startProviderLogin.mockResolvedValue({ id: "login-1" });
  });

  it("rejects an unknown auth type before starting login", async () => {
    const response = await POST(
      request({ type: 123 }),
      { params: Promise.resolve({ id: "anthropic" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startProviderLogin).not.toHaveBeenCalled();
  });
});
