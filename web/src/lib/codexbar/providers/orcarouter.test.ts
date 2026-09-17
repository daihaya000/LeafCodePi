import { afterEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import {
  createOrcaRouterProvider,
  orcarouterProvider,
  parseOrcaRouterBilling,
  resolveOrcaRouterApiKey,
  ORCAROUTER_BILLING_BASE,
} from "./orcarouter";

afterEach(() => {
  undiciFetch.mockReset();
  vi.unstubAllEnvs();
});

describe("orcarouter usage provider", () => {
  it("converts OpenAI-shaped billing responses from cents to USD", () => {
    const snapshot = parseOrcaRouterBilling(
      JSON.stringify({
        has_payment_method: true,
        hard_limit_usd: 25,
        access_until: 1_800_000_000,
      }),
      JSON.stringify({ total_usage: 1234 }),
    );

    expect(snapshot).toMatchObject({
      providerId: "orcarouter",
      plan: "Pay-as-you-go",
      creditsUsed: 12.34,
      creditsLimit: 25,
      creditsBalance: 12.66,
      creditsLabel: "USD",
    });
  });

  it("fetches subscription and usage with the configured key", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "C:\\missing-agent");
    vi.stubEnv("ORCAROUTER_API_KEY", "shared-key");
    undiciFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ has_payment_method: true, hard_limit_usd: 25 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_usage: 1234 }), { status: 200 }),
      );

    const snapshot = await orcarouterProvider.fetch();
    expect(snapshot.creditsUsed).toBe(12.34);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    const [subscriptionCall, usageCall] = undiciFetch.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(subscriptionCall[0]).toBe(
      `${ORCAROUTER_BILLING_BASE}/dashboard/billing/subscription`,
    );
    const usageUrl = new URL(usageCall[0]);
    expect(usageUrl.pathname).toBe("/v1/dashboard/billing/usage");
    expect(usageUrl.searchParams.get("start_date")).toMatch(/^\d{4}-\d{2}-01$/);
    expect(usageUrl.searchParams.get("end_date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((subscriptionCall[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer shared-key",
    );
    expect((usageCall[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer shared-key",
    );
  });

  it("uses stored account credentials without falling back to the environment", () => {
    vi.stubEnv("ORCAROUTER_API_KEY", "shared-key");
    const scope = {
      key: "account:one",
      kind: "account" as const,
      accountId: "one",
      accountLabel: "One",
      authPath: "C:\\missing-auth.json",
    };
    const provider = createOrcaRouterProvider(scope);

    expect(resolveOrcaRouterApiKey(scope)).toBeNull();
    expect(provider.isConfigured()).toBe(false);
  });
});
