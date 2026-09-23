import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  parseOpenRouterCreditsJson,
  parseOpenRouterKeyJson,
  openrouterProvider,
} from "./providers/openrouter";
import {
  applyCreditBaseline,
  createAnthropicProvider,
  parseAnthropicPrepaidCreditsJson,
  parseClaudeUsageJson,
} from "./providers/anthropic";
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
    expect(snap.creditsTitle).toBe("キー利用枠");
    expect(snap.creditsUsed).toBe(4.26);
    expect(snap.creditsLimit).toBe(10);
    expect(snap.creditsBalance).toBeNull();
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

describe("parseOpenRouterCreditsJson", () => {
  it("calculates the account balance and rejects missing amounts", () => {
    expect(parseOpenRouterCreditsJson('{"data":{"total_credits":100.5,"total_usage":25.75}}'))
      .toEqual({ total: 100.5, used: 25.75, balance: 74.75 });
    expect(() => parseOpenRouterCreditsJson('{"data":{"total_credits":100}}'))
      .toThrow("残高応答形式が不正");
  });
});

describe("openrouterProvider.fetch (mock)", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    undiciFetch.mockReset();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
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

  it("shows actual account credits with an explicit management key", async () => {
    process.env.PI_CODING_AGENT_DIR = tempDir();
    process.env.OPENROUTER_API_KEY = "sk-stale-inference";
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-management";
    undiciFetch.mockImplementation(async () => new Response(
      JSON.stringify({ data: { total_credits: 100.5, total_usage: 25.75 } }),
      { status: 200 },
    ));

    const snap = await openrouterProvider.fetch();
    expect(snap.creditsTitle).toBe("アカウント残高");
    expect(snap.creditsBalance).toBe(74.75);
    expect(snap.creditsUsed).toBe(25.75);
    expect(snap.creditsLimit).toBe(100.5);
    expect(undiciFetch.mock.calls.map((call) => call[0])).toEqual([
      "https://openrouter.ai/api/v1/credits",
    ]);
    expect(authorizationHeader(0)).toBe("Bearer sk-management");
  });

  it("rejects an invalid management key without exposing its value", async () => {
    process.env.PI_CODING_AGENT_DIR = tempDir();
    process.env.OPENROUTER_API_KEY = "sk-inference";
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-management";
    undiciFetch.mockImplementation(async (url: string) => url.endsWith("/credits")
      ? new Response("denied", { status: 403 })
      : new Response(JSON.stringify({ data: { usage: 2, limit: null } }), { status: 200 }));

    await expect(openrouterProvider.fetch()).rejects.toThrow("管理キーが無効");
  });

  it("uses the account api key and never falls back to env", async () => {
    process.env.PI_CODING_AGENT_DIR = tempDir();
    process.env.OPENROUTER_API_KEY = "sk-env";
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-management";
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

describe("parseAnthropicPrepaidCreditsJson", () => {
  it("reads the prepaid balance in cents as USD", () => {
    const snap = parseAnthropicPrepaidCreditsJson(
      JSON.stringify({ amount: 1234, auto_reload_enabled: true }),
    );
    expect(snap.windows).toEqual([]);
    expect(snap.creditsEnabled).toBe(true);
    expect(snap.creditsTitle).toBe("API クレジット");
    expect(snap.creditsBalance).toBeCloseTo(12.34);
    expect(snap.creditsUsed).toBeNull();
    expect(snap.plan).toBe("API");
    // 残高から導出した％は表示専用（集計・ルーティングに使わない）
    expect(snap.usageDisplayOnly).toBe(true);
  });

  it("rejects a response without amount", () => {
    expect(() => parseAnthropicPrepaidCreditsJson("{}")).toThrow(
      "クレジット応答形式",
    );
  });
});

describe("anthropic api-key account (Console cookie)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    undiciFetch.mockReset();
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function accountAuth(apiKey: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-anthropic-api-"));
    tempDirs.push(dir);
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify(
        apiKey ? { anthropic: { type: "api_key", key: apiKey } } : {},
      ),
      "utf8",
    );
    return authPath;
  }

  function writeConsoleCookie(authPath: string): void {
    mkdirSync(join(authPath, ".."), { recursive: true });
    writeFileSync(
      join(authPath, "..", "anthropic-cookies.txt"),
      "# Netscape HTTP Cookie File\n" +
        ".claude.com\tTRUE\t/\tTRUE\t4102444800\tsessionKey\tsk-ant-sid01-test\n" +
        ".claude.com\tTRUE\t/\tTRUE\t4102444800\tlastActiveOrg\torg-1234\n",
      "utf8",
    );
  }

  function providerFor(authPath: string) {
    return createAnthropicProvider({
      key: "account:acc-1",
      kind: "account",
      accountId: "acc-1",
      accountLabel: "API 個人用",
      authPath,
    });
  }

  it("shows the Console prepaid balance for an api_key account", async () => {
    const authPath = accountAuth("sk-ant-api03-test");
    writeConsoleCookie(authPath);
    undiciFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ amount: 500 }), { status: 200 }),
    );

    const provider = providerFor(authPath);
    expect(provider.isConfigured()).toBe(true);
    const snap = await provider.fetch();

    expect(snap.creditsBalance).toBeCloseTo(5);
    expect(snap.windows).toEqual([]);
    const call = undiciFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "https://platform.claude.com/api/organizations/org-1234/prepaid/credits",
    );
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Cookie).toContain("sessionKey=sk-ant-sid01-test");
  });

  it("asks for the Console cookie when an api_key account has none", async () => {
    const authPath = accountAuth("sk-ant-api03-test");
    const provider = providerFor(authPath);
    expect(provider.isConfigured()).toBe(true);

    await expect(provider.fetch()).rejects.toThrow(
      "API キー残高には Anthropic Console の cookie が必要です",
    );
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("treats a Console session as a configured credential without an api key", async () => {
    const authPath = accountAuth(null);
    writeConsoleCookie(authPath);
    undiciFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ amount: 100 }), { status: 200 }),
    );

    const provider = providerFor(authPath);
    expect(provider.isConfigured()).toBe(true);
    const snap = await provider.fetch();
    expect(snap.creditsBalance).toBeCloseTo(1);
  });

  it("derives used/limit from the manually entered baseline", async () => {
    const authPath = accountAuth("sk-ant-api03-test");
    writeConsoleCookie(authPath);
    writeFileSync(
      join(authPath, "..", "anthropic.json"),
      JSON.stringify({ creditBaselineUsd: 100 }),
      "utf8",
    );
    undiciFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ amount: 3750 }), { status: 200 }),
    );

    const snap = await providerFor(authPath).fetch();

    expect(snap.creditsBalance).toBeCloseTo(37.5);
    expect(snap.creditsLimit).toBe(100);
    expect(snap.creditsUsed).toBeCloseTo(62.5);
  });
});

describe("applyCreditBaseline", () => {
  function snapshot(balance: number | null) {
    return {
      ...parseAnthropicPrepaidCreditsJson(JSON.stringify({ amount: 0 })),
      creditsBalance: balance,
    };
  }

  it("keeps the snapshot when no baseline is set", () => {
    const snap = applyCreditBaseline(snapshot(20), null);
    expect(snap.creditsLimit).toBeNull();
    expect(snap.creditsUsed).toBeNull();
  });

  it("clamps to zero when the balance exceeds the baseline", () => {
    const snap = applyCreditBaseline(snapshot(150), 100);
    expect(snap.creditsLimit).toBe(100);
    expect(snap.creditsUsed).toBe(0);
  });

  it("leaves a balance-less snapshot untouched", () => {
    const snap = applyCreditBaseline(snapshot(null), 100);
    expect(snap.creditsLimit).toBeNull();
  });
});
