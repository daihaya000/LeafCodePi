import { beforeEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
const readPiOAuthTokens = vi.hoisted(() =>
  vi.fn(() => ({ access: "token", refresh: null, accountId: null })),
);
const loadCodexBarConfig = vi.hoisted(() => vi.fn(() => ({})));
const codexResetAutoConsumeWindowMs = vi.hoisted(() =>
  vi.fn((): number | null => null),
);

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

vi.mock("@/lib/codexbar/pi-auth", () => ({
  readPiOAuthTokens,
  writeBackPiOAuthTokens: vi.fn(),
}));

vi.mock("@/lib/codexbar/codexbar-config", () => ({
  loadCodexBarConfig,
  codexResetAutoConsumeWindowMs,
}));

import { createOpenaiCodexProvider } from "./openai-codex";

const scope = {
  key: "default",
  kind: "default" as const,
  accountId: null,
  accountLabel: null,
  authPath: null,
};
const failureScope = {
  key: "account:auto-reset-failure",
  kind: "account" as const,
  accountId: "auto-reset-failure",
  accountLabel: "Failure test",
  authPath: "C:/test/auth.json",
};

function usageResponse(availableCount: number): Response {
  return new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 90,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 18000,
        },
      },
      rate_limit_reset_credits: { available_count: availableCount },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  undiciFetch.mockReset();
  readPiOAuthTokens.mockClear();
  loadCodexBarConfig.mockReset();
  loadCodexBarConfig.mockReturnValue({});
  codexResetAutoConsumeWindowMs.mockReset();
  codexResetAutoConsumeWindowMs.mockReturnValue(null);
});

describe("Codex automatic reset redemption", () => {
  it("does not redeem by default", async () => {
    undiciFetch.mockResolvedValueOnce(usageResponse(1));

    const snapshot = await createOpenaiCodexProvider(scope).fetch();

    expect(snapshot.rateLimitResetCreditsAvailable).toBe(1);
    expect(undiciFetch).toHaveBeenCalledOnce();
  });

  it("keeps valid usage when the automatic check fails", async () => {
    loadCodexBarConfig.mockReturnValue({ codexResetAutoConsume: true });
    codexResetAutoConsumeWindowMs.mockReturnValue(24 * 60 * 60 * 1000);
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }));

    const snapshot = await createOpenaiCodexProvider(failureScope).fetch();

    expect(snapshot.rateLimitResetCreditsAvailable).toBe(1);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
  });

  it("redeems one expiring credit only after explicit opt-in", async () => {
    loadCodexBarConfig.mockReturnValue({ codexResetAutoConsume: true });
    codexResetAutoConsumeWindowMs.mockReturnValue(24 * 60 * 60 * 1000);
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available_count: 1,
            credits: [
              {
                id: "expiring",
                status: "available",
                expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "reset" }), { status: 200 }),
      )
      .mockResolvedValueOnce(usageResponse(1));

    const provider = createOpenaiCodexProvider(scope);
    const snapshot = await provider.fetch();
    const secondSnapshot = await provider.fetch();

    expect(snapshot.rateLimitResetCreditsAvailable).toBe(0);
    expect(secondSnapshot.rateLimitResetCreditsAvailable).toBe(1);
    expect(undiciFetch).toHaveBeenCalledTimes(4);
    const [, init] = undiciFetch.mock.calls[2] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      credit_id: "expiring",
      redeem_request_id: "auto-expiring",
    });
  });
});
