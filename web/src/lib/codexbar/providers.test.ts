import { afterEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import { parseOpenRouterKeyJson, openrouterProvider } from "./providers/openrouter";
import { parseClaudeUsageJson } from "./providers/anthropic";
import { parseCodexUsageJson } from "./providers/openai-codex";
import { parseCursorUsageSummary } from "./providers/cursor";

describe("parseOpenRouterKeyJson", () => {
  it("parses limited key usage as credits", () => {
    const snap = parseOpenRouterKeyJson(
      JSON.stringify({
        data: {
          usage: 4.26,
          limit: 10,
          limit_remaining: 5.74,
          is_free_tier: false,
        },
      }),
    );
    expect(snap.windows).toEqual([]);
    expect(snap.creditsEnabled).toBe(true);
    expect(snap.creditsTitle).toBe("利用額");
    expect(snap.creditsUsed).toBe(4.26);
    expect(snap.creditsLimit).toBe(10);
    expect(snap.creditsBalance).toBeCloseTo(5.74);
    expect(snap.plan).toBe("Pay-as-you-go");
  });

  it("treats null/0 limit as unbounded", () => {
    const snap = parseOpenRouterKeyJson(
      JSON.stringify({ data: { usage: 1.5, limit: null, is_free_tier: true } }),
    );
    expect(snap.creditsLimit).toBeNull();
    expect(snap.creditsBalance).toBeNull();
    expect(snap.plan).toBe("Free");
  });
});

describe("openrouterProvider.fetch (mock)", () => {
  afterEach(() => {
    undiciFetch.mockReset();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("calls the key API with the bearer token", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    undiciFetch.mockImplementation(async () =>
      new Response(
        JSON.stringify({ data: { usage: 2, limit: 5, limit_remaining: 3 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const snap = await openrouterProvider.fetch();
    expect(snap.creditsUsed).toBe(2);
    expect(undiciFetch).toHaveBeenCalledOnce();
    const call = undiciFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://openrouter.ai/api/v1/key");
    expect((call[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });
});

describe("parseClaudeUsageJson", () => {
  it("parses flat windows and extra_usage cents", () => {
    const snap = parseClaudeUsageJson(
      JSON.stringify({
        five_hour: { utilization: 12.5, resets_at: "2026-08-21T10:00:00Z" },
        seven_day: { utilization: 40 },
        extra_usage: {
          is_enabled: true,
          used_credits: 1250,
          monthly_limit: 30000,
          currency: "USD",
          decimal_places: 2,
        },
      }),
      "pro",
    );
    expect(snap.plan).toBe("Pro");
    expect(snap.windows[0]).toMatchObject({
      id: "claude-5h",
      title: "5時間",
      usedPercent: 12.5,
    });
    expect(snap.creditsEnabled).toBe(true);
    expect(snap.creditsUsed).toBe(12.5);
    expect(snap.creditsLimit).toBe(300);
  });
});

describe("parseCodexUsageJson", () => {
  it("parses primary/secondary rate windows", () => {
    const snap = parseCodexUsageJson(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 8,
            reset_at: 1755760000,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 22,
            reset_at: 1756364800,
            limit_window_seconds: 604800,
          },
        },
        credits: { balance: 3.5 },
      }),
    );
    expect(snap.plan).toBe("Plus");
    expect(snap.windows).toHaveLength(2);
    expect(snap.windows[0].title).toBe("5時間");
    expect(snap.windows[1].title).toBe("週間");
    expect(snap.creditsBalance).toBe(3.5);
  });
});

describe("parseCursorUsageSummary", () => {
  it("counts only plan toward aggregate and keeps Auto as breakdown", () => {
    const snap = parseCursorUsageSummary({
      membershipType: "pro",
      billingCycleEnd: "2026-09-01T00:00:00Z",
      individualUsage: {
        plan: {
          totalPercentUsed: 35,
          autoPercentUsed: 90,
          apiPercentUsed: 10,
        },
      },
    });
    expect(snap.plan).toBe("Pro");
    expect(snap.windows[0]).toMatchObject({
      id: "cursor-plan",
      usedPercent: 35,
      countsTowardLimit: true,
    });
    expect(snap.windows.find((w) => w.id === "cursor-auto")?.countsTowardLimit).toBe(
      false,
    );
  });
});
