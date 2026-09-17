import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrcaRouterProvider,
  parseOrcaRouterBilling,
  resolveOrcaRouterApiKey,
} from "./orcarouter";

afterEach(() => {
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
