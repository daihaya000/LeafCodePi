import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  logoutProvider: vi.fn(),
  isPeerAccount: vi.fn((_id: string, _agentDir: string) => false),
  resolvePiAgentDir: vi.fn(async () => "/agent"),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/peer-auth/account-runtime-options", () => ({ isPeerAccount: mocks.isPeerAccount }));
vi.mock("@/lib/accounts", () => ({ resolvePiAgentDir: mocks.resolvePiAgentDir }));

import { POST } from "@backend-runtime/json-business/handlers/providers/[id]/logout/route";

function request(accountId?: string): Request {
  const url = new URL("http://localhost/api/providers/anthropic/logout");
  if (accountId) url.searchParams.set("accountId", accountId);
  return new Request(url, { method: "POST" });
}

describe("POST /api/providers/[id]/logout", () => {
  beforeEach(() => {
    mocks.logoutProvider.mockReset();
    mocks.logoutProvider.mockResolvedValue(undefined);
    mocks.isPeerAccount.mockReset();
    mocks.isPeerAccount.mockReturnValue(false);
  });

  it("refuses to log out a peer account and points at the sharing LCP", async () => {
    mocks.isPeerAccount.mockImplementation((id: string) => id === "peer-1");
    const response = await POST(request("peer-1"), { params: Promise.resolve({ id: "anthropic" }) });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("共有元のLCP");
    expect(mocks.logoutProvider).not.toHaveBeenCalled();
  });

  it("logs out ordinary and default accounts", async () => {
    for (const accountId of ["local-1", undefined]) {
      expect((await POST(request(accountId), { params: Promise.resolve({ id: "anthropic" }) })).status).toBe(200);
    }
    expect(mocks.logoutProvider).toHaveBeenCalledTimes(2);
    expect(mocks.logoutProvider).toHaveBeenCalledWith("anthropic", "local-1");
    expect(mocks.logoutProvider).toHaveBeenCalledWith("anthropic", null);
  });
});
