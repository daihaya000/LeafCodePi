import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageScope } from "./types";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import {
  createOpenRouterProvider,
  parseOpenRouterKeyJson,
  openrouterProvider,
} from "./providers/openrouter";
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
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    undiciFetch.mockReset();
    delete process.env.OPENROUTER_API_KEY;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-openrouter-"));
    tempDirs.push(dir);
    return dir;
  }

  function mockKeyResponse(): void {
    undiciFetch.mockImplementation(async () =>
      new Response(
        JSON.stringify({ data: { usage: 2, limit: 5, limit_remaining: 3 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  function authorizationHeader(index = 0): string | undefined {
    const call = undiciFetch.mock.calls[index] as unknown as [string, RequestInit];
    return (call[1].headers as Record<string, string>).Authorization;
  }

  it("calls the key API with the bearer token", async () => {
    // 実利用者の ~/.pi/agent/auth.json を読まないよう既定 auth パスを隔離する
    process.env.PI_CODING_AGENT_DIR = tempDir();
    process.env.OPENROUTER_API_KEY = "sk-test";
    mockKeyResponse();

    const snap = await openrouterProvider.fetch();
    expect(snap.creditsUsed).toBe(2);
    expect(undiciFetch).toHaveBeenCalledOnce();
    const call = undiciFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://openrouter.ai/api/v1/key");
    expect(authorizationHeader()).toBe("Bearer sk-test");
  });

  it("uses the account api key and never falls back to env", async () => {
    process.env.PI_CODING_AGENT_DIR = tempDir();
    process.env.OPENROUTER_API_KEY = "sk-env";
    const dir = tempDir();
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-account" } }),
      "utf8",
    );
    const scope: UsageScope = {
      key: "account:acc-1",
      kind: "account",
      accountId: "acc-1",
      accountLabel: "個人用",
      authPath,
    };
    mockKeyResponse();

    const provider = createOpenRouterProvider(scope);
    expect(provider.isConfigured()).toBe(true);
    await provider.fetch();
    expect(authorizationHeader()).toBe("Bearer sk-account");

    // キー未登録のアカウントは env の共有キーを流用しない
    const unconfigured = createOpenRouterProvider({
      ...scope,
      authPath: join(dir, "missing.json"),
    });
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.fetch()).rejects.toThrow("API キーが未設定です");
    expect(undiciFetch).toHaveBeenCalledOnce();
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
    expect(snap.rateLimitResetCreditsAvailable).toBeNull();
  });

  it("parses banked rate-limit reset available_count", () => {
    const snap = parseCodexUsageJson(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 90,
            reset_at: 1755760000,
            limit_window_seconds: 18000,
          },
        },
        rate_limit_reset_credits: { available_count: 2 },
      }),
    );
    expect(snap.rateLimitResetCreditsAvailable).toBe(2);
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
