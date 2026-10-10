import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  startProviderLogin: vi.fn(),
  isPeerAccount: vi.fn((_id: string, _agentDir: string) => false),
  resolvePiAgentDir: vi.fn(async () => "/agent"),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/peer-auth/account-runtime-options", () => ({ isPeerAccount: mocks.isPeerAccount }));
vi.mock("@/lib/accounts", () => ({ resolvePiAgentDir: mocks.resolvePiAgentDir }));

import { POST } from "@backend-runtime/json-business/handlers/providers/[id]/login/route";

function request(body: unknown, accountId?: string): Request {
  const url = new URL("http://localhost/api/providers/anthropic/login");
  if (accountId) url.searchParams.set("accountId", accountId);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/[id]/login", () => {
  beforeEach(() => {
    mocks.startProviderLogin.mockReset();
    mocks.startProviderLogin.mockResolvedValue({ id: "login-1" });
    mocks.isPeerAccount.mockReset();
    mocks.isPeerAccount.mockReturnValue(false);
  });

  it("rejects an unknown auth type before starting login", async () => {
    const response = await POST(
      request({ type: 123 }),
      { params: Promise.resolve({ id: "anthropic" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startProviderLogin).not.toHaveBeenCalled();
  });

  it("refuses to log in a peer account that takes its credentials from another LCP", async () => {
    mocks.isPeerAccount.mockImplementation((id: string) => id === "peer-1");
    const response = await POST(
      request({ type: "oauth" }, "peer-1"),
      { params: Promise.resolve({ id: "anthropic" }) },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("別のLCP");
    expect(mocks.startProviderLogin).not.toHaveBeenCalled();
  });

  it("still logs in ordinary accounts and the default account", async () => {
    for (const accountId of ["local-1", undefined]) {
      const response = await POST(
        request({ type: "oauth" }, accountId),
        { params: Promise.resolve({ id: "anthropic" }) },
      );
      expect(response.status).toBe(200);
    }
    expect(mocks.isPeerAccount).not.toHaveBeenCalledWith(undefined, expect.anything());
    expect(mocks.startProviderLogin).toHaveBeenCalledTimes(2);
  });
});
