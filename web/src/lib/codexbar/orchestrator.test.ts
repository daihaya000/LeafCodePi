import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCachedUsage } from "@/lib/codexbar/cache";
import { groupCodexBarProviders } from "@/lib/codexbar";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { __resetPiAgentDirCacheForTests } from "@/lib/accounts";
import { fetchNativeUsage } from "./orchestrator";

vi.mock("@/lib/codexbar/provider-catalog", () => ({
  resolveEnabledProviderIds: () => ["openai-codex"],
}));

const tempDirs: string[] = [];

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

afterEach(() => {
  vi.unstubAllGlobals();
  clearCachedUsage();
  clearProviderCache();
  __resetPiAgentDirCacheForTests();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.LEAFCODE_PI_DATA_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fetchNativeUsage", () => {
  it("fetches Codex usage independently for each registered account", async () => {
    setupAccounts();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "all" },
    });
    const group = groupCodexBarProviders(usage)[0];

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(group.provider.usedPercent).toBe(60);
    expect(group.accountRows.map((row) => row.label)).toEqual(["仕事用", "個人用"]);
    expect(group.accountRows.map((row) => row.provider?.usedPercent)).toEqual([100, 20]);
    expect(
      (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
        ([url, init]) => [url, (init.headers as Record<string, string>).Authorization],
      ),
    ).toEqual([
      ["https://chatgpt.com/backend-api/wham/usage", "Bearer token-a"],
      ["https://chatgpt.com/backend-api/wham/usage", "Bearer token-b"],
    ]);
  }, 15_000);

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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchNativeUsage({
      forceRefresh: true,
      scope: { kind: "account", accountId: "acc-empty" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usage.accounts?.[0]).toMatchObject({
      id: "acc-empty",
      configuredProviders: [],
    });
  });
});
