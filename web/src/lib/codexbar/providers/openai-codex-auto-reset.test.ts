import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
const readPiOAuthTokens = vi.hoisted(() =>
  vi.fn(() => ({ access: "token", refresh: null, accountId: null })),
);
const loadCodexBarConfig = vi.hoisted(() => vi.fn(() => ({})));
const getAccount = vi.hoisted(() => vi.fn((): { enabled: boolean; codexResetAutoConsume?: boolean } | undefined => ({ enabled: true })));
vi.mock("@/lib/accounts", () => ({ getAccount }));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

vi.mock("@/lib/codexbar/pi-auth", () => ({
  // This fixture supplies mocked tokens, never the real default-account recovery path.
  piAuthPathFor: vi.fn(() => undefined),
  readPiOAuthTokens,
  writeBackPiOAuthTokens: vi.fn(),
}));

// Use the real window policy so configuration regressions cannot be hidden by mocks.
vi.mock("@/lib/codexbar/codexbar-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codexbar/codexbar-config")>()),
  loadCodexBarConfig,
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

function usageResponse(availableCount?: number): Response {
  return new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 90,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 18000,
        },
      },
      ...(availableCount === undefined ? {} : { rate_limit_reset_credits: { available_count: availableCount } }),
    }),
    { status: 200 },
  );
}

function creditListResponse(minutes = 60): Response {
  return new Response(JSON.stringify({
    available_count: 1,
    credits: [{ id: "expiring", status: "available", expires_at: new Date(Date.now() + minutes * 60_000).toISOString() }],
  }), { status: 200 });
}

function accountScope(id: string) {
  return { ...failureScope, key: `account:${id}`, accountId: id };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  undiciFetch.mockReset();
  readPiOAuthTokens.mockClear();
  loadCodexBarConfig.mockReset();
  loadCodexBarConfig.mockReturnValue({});
  getAccount.mockReset().mockReturnValue({ enabled: true });
});

describe("Codex automatic reset redemption", () => {
  it.each([{}, { codexResetAutoConsume: false }, { codexResetAutoConsumeWindowHours: 0 }])("redeems by default with missing or invalid config %j", async (config) => {
    loadCodexBarConfig.mockReturnValue(config);
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(60))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    const snapshot = await createOpenaiCodexProvider(accountScope(`always-on-${JSON.stringify(config)}`)).fetch();
    expect(snapshot.rateLimitResetCreditsAvailable).toBe(0);
    expect(undiciFetch).toHaveBeenCalledTimes(3);
  });

  it("does not consume when explicitly disabled in settings", async () => {
    getAccount.mockReturnValue({ enabled: true, codexResetAutoConsume: false });
    undiciFetch.mockResolvedValueOnce(usageResponse(1));
    expect((await createOpenaiCodexProvider(accountScope("disabled")).fetch()).rateLimitResetCreditsAvailable).toBe(1);
    expect(undiciFetch).toHaveBeenCalledOnce();
  });

  it("an OFF account does not disable automatic redemption for another account", async () => {
    getAccount.mockImplementation((...args: unknown[]) => ({ enabled: true, codexResetAutoConsume: args[0] !== "off" }));
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    await createOpenaiCodexProvider(accountScope("off")).fetch();
    await createOpenaiCodexProvider(accountScope("on")).fetch();
    expect(undiciFetch).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, { enabled: false }])("does not consume for missing or paused accounts %j", async (account) => {
    getAccount.mockReturnValue(account);
    undiciFetch.mockResolvedValueOnce(usageResponse(1));
    await createOpenaiCodexProvider(accountScope("unavailable")).fetch();
    expect(undiciFetch).toHaveBeenCalledOnce();
  });

  it("does not request reset credits when none are available", async () => {
    undiciFetch.mockResolvedValueOnce(usageResponse(0));
    expect((await createOpenaiCodexProvider(accountScope("no-credits")).fetch()).rateLimitResetCreditsAvailable).toBe(0);
    expect(undiciFetch).toHaveBeenCalledOnce();
  });

  it("keeps valid usage when the automatic check fails", async () => {
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }));

    const snapshot = await createOpenaiCodexProvider(failureScope).fetch();

    expect(snapshot.rateLimitResetCreditsAvailable).toBe(1);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a temporary failure on the next poll instead of suppressing it for an hour", async () => {
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(2))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    const provider = createOpenaiCodexProvider(accountScope("retry"));
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(1);
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(0);
    expect(undiciFetch).toHaveBeenCalledTimes(5);
  });

  it("retries when usage becomes resettable after nothing_to_reset", async () => {
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(2))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "nothing_to_reset" }), { status: 200 }))
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(1))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    const provider = createOpenaiCodexProvider(accountScope("retry-business"));
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(1);
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(0);
    expect(undiciFetch).toHaveBeenCalledTimes(6);
  });

  it("uses the credits endpoint when usage omits the available count", async () => {
    undiciFetch
      .mockResolvedValueOnce(usageResponse())
      .mockResolvedValueOnce(creditListResponse(2))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    expect((await createOpenaiCodexProvider(accountScope("unknown-count")).fetch()).rateLimitResetCreditsAvailable).toBeNull();
    expect(undiciFetch).toHaveBeenCalledTimes(3);
  });

  it("checks a short expiry window again after five minutes", async () => {
    vi.useFakeTimers();
    loadCodexBarConfig.mockReturnValue({ codexResetAutoConsumeWindowHours: 10 / 60 });
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(11))
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(6))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    const provider = createOpenaiCodexProvider(accountScope("short-window"));
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(0);
    expect(undiciFetch).toHaveBeenCalledTimes(5);
  });

  it("does not throttle beyond a two-minute expiry window", async () => {
    vi.useFakeTimers();
    loadCodexBarConfig.mockReturnValue({ codexResetAutoConsumeWindowHours: 2 / 60 });
    undiciFetch
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(2.5))
      .mockResolvedValueOnce(usageResponse(1))
      .mockResolvedValueOnce(creditListResponse(1.5))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "reset" }), { status: 200 }));
    const provider = createOpenaiCodexProvider(accountScope("two-minute-window"));
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await provider.fetch()).rateLimitResetCreditsAvailable).toBe(0);
  });

  it("automatically redeems one credit and coalesces subsequent checks", async () => {
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
