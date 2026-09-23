import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const {
  withOpenaiCodexWhamAuth,
  listCodexResetCredits,
  consumeCodexResetCredit,
  invalidateCachedUsage,
  clearProviderCache,
  getAccount,
  isAccountEnabled,
  extractAnthropicConsoleSession,
  consumeClaudeResetGrant,
} = vi.hoisted(() => ({
  extractAnthropicConsoleSession: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
  withOpenaiCodexWhamAuth: vi.fn(),
  listCodexResetCredits: vi.fn(),
  consumeCodexResetCredit: vi.fn(),
  invalidateCachedUsage: vi.fn(),
  clearProviderCache: vi.fn(),
  getAccount: vi.fn(),
  isAccountEnabled: vi.fn(),
}));

vi.mock("@/lib/codexbar/providers/openai-codex", () => ({
  withOpenaiCodexWhamAuth,
}));

vi.mock("@/lib/codexbar/providers/openai-codex-reset", () => ({
  listCodexResetCredits,
  consumeCodexResetCredit,
  describeResetConsumeCode: (code: string) => `msg:${code}`,
}));

vi.mock("@/lib/codexbar/cache", () => ({
  invalidateCachedUsage,
}));

vi.mock("@/lib/codexbar/provider-cache", () => ({
  clearProviderCache,
}));

vi.mock("@/lib/accounts", () => ({
  getAccount,
  isAccountEnabled,
  accountAuthPath: (id: string) => `/agent/accounts/${id}/auth.json`,
  resolvePiAgentDir: async () => "/agent",
}));

vi.mock("@/lib/codexbar/browser-cookies", () => ({
  extractAnthropicConsoleSession,
}));

vi.mock("@/lib/codexbar/providers/anthropic-reset", () => ({
  listClaudeResetGrants: vi.fn(),
  consumeClaudeResetGrant,
  describeClaudeResetCode: (code: string) => `claude:${code}`,
}));

describe("/api/codexbar/reset-credits", () => {
  beforeEach(() => {
    withOpenaiCodexWhamAuth.mockReset();
    listCodexResetCredits.mockReset();
    consumeCodexResetCredit.mockReset();
    invalidateCachedUsage.mockReset();
    clearProviderCache.mockReset();
    getAccount.mockReset();
    isAccountEnabled.mockReset();
    extractAnthropicConsoleSession.mockReset();
    consumeClaudeResetGrant.mockReset();
    getAccount.mockImplementation((id: string) =>
      id ? { id, enabled: true } : undefined,
    );
    isAccountEnabled.mockImplementation(
      (account: { enabled?: boolean }) => account.enabled !== false,
    );
  });

  it("GET lists credits for default auth when accountId is omitted", async () => {
    withOpenaiCodexWhamAuth.mockImplementationOnce(
      async (_accountId: string | null, run: (creds: unknown) => Promise<unknown>) => ({
        result: await run({ accessToken: "t", chatgptAccountId: null }),
        session: {
          leafcodeAccountId: null,
          instanceId: "default:openai-codex",
          credentials: { accessToken: "t", chatgptAccountId: null },
          refresh: async () => null,
        },
      }),
    );
    listCodexResetCredits.mockResolvedValueOnce({
      availableCount: 1,
      credits: [{ id: "c1", title: "Reset", status: "available" }],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/codexbar/reset-credits"),
    );
    expect(response.status).toBe(200);
    expect(withOpenaiCodexWhamAuth.mock.calls[0][0]).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      availableCount: 1,
      accountId: null,
      credits: [{ id: "c1" }],
    });
  });

  it("GET passes accountId through", async () => {
    withOpenaiCodexWhamAuth.mockImplementationOnce(
      async (accountId: string | null, run: (creds: unknown) => Promise<unknown>) => ({
        result: await run({ accessToken: "t", chatgptAccountId: "cg" }),
        session: {
          leafcodeAccountId: accountId,
          instanceId: `account:${accountId}:openai-codex`,
          credentials: { accessToken: "t", chatgptAccountId: "cg" },
          refresh: async () => null,
        },
      }),
    );
    listCodexResetCredits.mockResolvedValueOnce({
      availableCount: 0,
      credits: [],
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/codexbar/reset-credits?accountId=acc-1",
      ),
    );
    expect(response.status).toBe(200);
    expect(withOpenaiCodexWhamAuth.mock.calls[0][0]).toBe("acc-1");
  });

  it("GET rejects paused accounts with 409", async () => {
    getAccount.mockReturnValueOnce({ id: "acc-paused", enabled: false });
    isAccountEnabled.mockReturnValueOnce(false);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/codexbar/reset-credits?accountId=acc-paused",
      ),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "一時停止中のアカウントです",
    });
    expect(withOpenaiCodexWhamAuth).not.toHaveBeenCalled();
  });

  it("POST rejects missing creditId", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/codexbar/reset-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    expect(withOpenaiCodexWhamAuth).not.toHaveBeenCalled();
  });

  it("POST invalidates caches on successful redeem", async () => {
    withOpenaiCodexWhamAuth.mockImplementationOnce(
      async (_accountId: string | null, run: (creds: unknown) => Promise<unknown>) => ({
        result: await run({ accessToken: "t", chatgptAccountId: null }),
        session: {
          leafcodeAccountId: null,
          instanceId: "default:openai-codex",
          credentials: { accessToken: "t", chatgptAccountId: null },
          refresh: async () => null,
        },
      }),
    );
    consumeCodexResetCredit.mockResolvedValueOnce({
      ok: true,
      code: "reset",
      status: 200,
      windowsReset: 2,
      creditId: "c1",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/codexbar/reset-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditId: "c1", redeemRequestId: "r1" }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      code: "reset",
      message: "msg:reset",
    });
    expect(invalidateCachedUsage).toHaveBeenCalledOnce();
    expect(clearProviderCache).toHaveBeenCalledWith("default:openai-codex");
  });

  it("POST returns ok:false without clearing cache for nothing_to_reset", async () => {
    withOpenaiCodexWhamAuth.mockImplementationOnce(
      async (_accountId: string | null, run: (creds: unknown) => Promise<unknown>) => ({
        result: await run({ accessToken: "t", chatgptAccountId: null }),
        session: {
          leafcodeAccountId: null,
          instanceId: "default:openai-codex",
          credentials: { accessToken: "t", chatgptAccountId: null },
          refresh: async () => null,
        },
      }),
    );
    consumeCodexResetCredit.mockResolvedValueOnce({
      ok: false,
      code: "nothing_to_reset",
      status: 200,
      windowsReset: null,
      creditId: "c1",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/codexbar/reset-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditId: "c1" }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "nothing_to_reset",
    });
    expect(invalidateCachedUsage).not.toHaveBeenCalled();
  });

  it("POST provider=anthropic redeems with the account claude.ai cookie", async () => {
    const session = { sourceLabel: "t", cookies: [] };
    extractAnthropicConsoleSession.mockReturnValueOnce(session);
    consumeClaudeResetGrant.mockResolvedValueOnce({
      ok: true,
      code: "reset",
      grantId: "g1",
      resetsLeft: 0,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/codexbar/reset-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditId: "g1", accountId: "acc-1", provider: "anthropic" }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, message: "claude:reset" });
    expect(extractAnthropicConsoleSession).toHaveBeenCalledWith({
      authPath: "/agent/accounts/acc-1/auth.json",
    });
    expect(consumeClaudeResetGrant).toHaveBeenCalledWith(session, { grantId: "g1", requestId: undefined });
    expect(clearProviderCache).toHaveBeenCalledWith("account:acc-1:anthropic");
    expect(withOpenaiCodexWhamAuth).not.toHaveBeenCalled();
  });

  it("POST provider=anthropic without cookie returns 401", async () => {
    extractAnthropicConsoleSession.mockReturnValueOnce(null);
    const response = await POST(
      new NextRequest("http://localhost/api/codexbar/reset-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditId: "g1", provider: "anthropic" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(consumeClaudeResetGrant).not.toHaveBeenCalled();
  });
});
