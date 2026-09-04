import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const {
  withOpenaiCodexWhamAuth,
  listCodexResetCredits,
  consumeCodexResetCredit,
  invalidateCachedUsage,
  clearProviderCache,
} = vi.hoisted(() => ({
  withOpenaiCodexWhamAuth: vi.fn(),
  listCodexResetCredits: vi.fn(),
  consumeCodexResetCredit: vi.fn(),
  invalidateCachedUsage: vi.fn(),
  clearProviderCache: vi.fn(),
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

describe("/api/codexbar/reset-credits", () => {
  beforeEach(() => {
    withOpenaiCodexWhamAuth.mockReset();
    listCodexResetCredits.mockReset();
    consumeCodexResetCredit.mockReset();
    invalidateCachedUsage.mockReset();
    clearProviderCache.mockReset();
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
});
