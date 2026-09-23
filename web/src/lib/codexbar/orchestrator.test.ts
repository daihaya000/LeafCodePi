import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCachedUsage } from "@/lib/codexbar/cache";
import { groupCodexBarProviders } from "@/lib/codexbar";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { __resetPiAgentDirCacheForTests } from "@/lib/accounts";
import { fetchNativeUsage } from "./orchestrator";

const enabledProviderIds = vi.hoisted(() => ["openai-codex"]);
vi.mock("@/lib/codexbar/provider-catalog", () => ({
  resolveEnabledProviderIds: () => enabledProviderIds,
}));

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function setupAccounts(): { accountDir: string; dataDir: string } {
  const accountDir = mkdtempSync(join(tmpdir(), "leafcode-codexbar-agent-"));
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-codexbar-data-"));
  tempDirs.push(accountDir, dataDir);
  process.env.PI_CODING_AGENT_DIR = accountDir;
  process.env.LEAFCODE_PI_DATA_DIR = dataDir;
  __resetPiAgentDirCacheForTests();

  const accounts = [
    {
      id: "acc-a",
      label: "仕事用",
      providers: ["openai-codex"],
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    {
      id: "acc-b",
      label: "個人用",
      providers: ["openai-codex"],
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
  ];
  writeJson(join(dataDir, "accounts.json"), { version: 1, accounts });
  writeJson(join(accountDir, "accounts", "acc-a", "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: "token-a",
      refresh: "refresh-a",
      accountId: "chat-a",
    },
  });
  writeJson(join(accountDir, "accounts", "acc-b", "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: "token-b",
      refresh: "refresh-b",
      accountId: "chat-b",
    },
  });
  return { accountDir, dataDir };
}

function setupEmptyAccounts(): { accountDir: string; dataDir: string } {
  const accountDir = mkdtempSync(join(tmpdir(), "leafcode-codexbar-agent-"));
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-codexbar-data-"));
  tempDirs.push(accountDir, dataDir);
  process.env.PI_CODING_AGENT_DIR = accountDir;
  process.env.LEAFCODE_PI_DATA_DIR = dataDir;
  __resetPiAgentDirCacheForTests();
  writeJson(join(dataDir, "accounts.json"), { version: 1, accounts: [] });
  return { accountDir, dataDir };
}

afterEach(() => {
  undiciFetch.mockReset();
  enabledProviderIds.splice(0, enabledProviderIds.length, "openai-codex");
  if (originalManagementKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
  else process.env.OPENROUTER_MANAGEMENT_KEY = originalManagementKey;
  clearCachedUsage();
  clearProviderCache();
  __resetPiAgentDirCacheForTests();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fetchNativeUsage", () => {
  it("shows management-only OpenRouter credits in the normal all-scope widget", async () => {
    setupEmptyAccounts();
    enabledProviderIds.splice(0, enabledProviderIds.length, "openrouter");
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-management";
    undiciFetch.mockImplementation(async () => new Response(
      JSON.stringify({ data: { total_credits: 20, total_usage: 3 } }),
      { status: 200 },
    ));

    const usage = await fetchNativeUsage({ forceRefresh: true, scope: { kind: "all" } });
    expect(undiciFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/credits",
    ]);
    expect(groupCodexBarProviders(usage)[0].provider.credits?.balance).toBe(17);
  });

  it("shows global credits separately from account-specific key usage", async () => {
    const { accountDir, dataDir } = setupAccounts();
    enabledProviderIds.splice(0, enabledProviderIds.length, "openrouter");
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-management";
    const accountData = JSON.parse(readFileSync(join(dataDir, "accounts.json"), "utf8")) as {
      accounts: Array<Record<string, unknown>>;
    };
    for (const account of accountData.accounts) {
      account.providers = ["openrouter"];
      writeJson(join(accountDir, "accounts", account.id as string, "auth.json"), {
        openrouter: { type: "api_key", key: `sk-${account.id}` },
      });
    }
    writeJson(join(dataDir, "accounts.json"), accountData);
    undiciFetch.mockImplementation(async (url: string) => new Response(
      JSON.stringify(url.endsWith("/credits")
        ? { data: { total_credits: 20, total_usage: 3 } }
        : { data: { usage: 1, limit: 5 } }),
      { status: 200 },
    ));

    const usage = await fetchNativeUsage({ forceRefresh: true, scope: { kind: "all" } });
    const group = groupCodexBarProviders(usage)[0];
    expect(group.accountRows.map((row) => row.label)).toEqual(["仕事用", "個人用", "全体"]);
    expect(group.accountRows.map((row) => row.provider?.credits?.balance)).toEqual([null, null, 17]);
    expect(group.provider.usedPercent).toBe(20); // global spend is display-only
    expect(undiciFetch.mock.calls).toHaveLength(3);
  });

  it("fetches Codex usage independently for each registered account", async () => {
    setupAccounts();
    undiciFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers.Authorization?.replace("Bearer ", "");
      const percent = token === "token-a" ? 100 : 20;
      return new Response(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: percent,
              reset_at: 1_800_000_000,
              limit_window_seconds: 18_000,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "all" },
    });
    const group = groupCodexBarProviders(usage)[0];

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(group.provider.usedPercent).toBe(60);
    expect(group.accountRows.map((row) => row.label)).toEqual(["仕事用", "個人用"]);
    expect(group.accountRows.map((row) => row.provider?.usedPercent)).toEqual([100, 20]);
    expect(
      (undiciFetch.mock.calls as unknown as [string, RequestInit][]).map(
        ([url, init]) => [url, (init.headers as Record<string, string>).Authorization],
      ),
    ).toEqual([
      ["https://chatgpt.com/backend-api/wham/usage", "Bearer token-a"],
      ["https://chatgpt.com/backend-api/wham/usage", "Bearer token-b"],
    ]);
  }, 15_000);

  it("does not fetch usage for paused accounts", async () => {
    const { dataDir } = setupAccounts();
    const accountData = JSON.parse(
      readFileSync(join(dataDir, "accounts.json"), "utf8"),
    ) as { accounts: Array<Record<string, unknown>> };
    accountData.accounts[1] = { ...accountData.accounts[1], enabled: false };
    writeJson(join(dataDir, "accounts.json"), {
      version: 1,
      accounts: accountData.accounts,
    });
    undiciFetch.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          rate_limit: { primary_window: { used_percent: 20 } },
        }),
        { status: 200 },
      ),
    );

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "all" },
    });

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(usage.accounts?.map((account) => account.id)).toEqual(["acc-a"]);
  });

  it("does not fall back to local auth when no account is registered", async () => {
    const { accountDir } = setupEmptyAccounts();
    writeJson(join(accountDir, "auth.json"), {
      "openai-codex": { type: "oauth", access: "default-token" },
    });
    const codexHome = mkdtempSync(join(tmpdir(), "leafcode-codexbar-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    writeJson(join(codexHome, "auth.json"), {
      tokens: { access_token: "cli-token" },
    });
    undiciFetch.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 35 },
          },
        }),
        { status: 200 },
      ),
    );

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "all" },
    });

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(usage).toMatchObject({ available: false, providers: [] });
  });

  it("does not use default auth for an account scope", async () => {
    const { accountDir, dataDir } = setupAccounts();
    writeJson(join(accountDir, "auth.json"), {
      "openai-codex": { type: "oauth", access: "default-token" },
    });
    const accountData = JSON.parse(
      readFileSync(join(dataDir, "accounts.json"), "utf8"),
    ) as { accounts: Array<Record<string, unknown>> };
    accountData.accounts = [
      {
        ...accountData.accounts[0],
        id: "acc-empty",
        label: "未ログイン",
      },
    ];
    writeJson(join(dataDir, "accounts.json"), { version: 1, accounts: accountData.accounts });

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "account", accountId: "acc-empty" },
    });

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(usage.accounts?.[0]).toMatchObject({
      id: "acc-empty",
      configuredProviders: [],
    });
  });
});
