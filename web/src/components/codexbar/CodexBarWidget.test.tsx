// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBarUsage } from "@/lib/codexbar";
import { CodexBarWidget } from "./CodexBarWidget";
import { resetWidgetSettingsCache } from "@/lib/use-widget-settings";

const { useCodexUsage, useCodexProviders, getJson, sendJson } = vi.hoisted(() => ({
  useCodexUsage: vi.fn(),
  useCodexProviders: vi.fn(),
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("./use-codex-usage", () => ({ useCodexUsage }));
vi.mock("./use-codex-providers", () => ({ useCodexProviders }));
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    getJson,
    sendJson,
  };
});

const usage: CodexBarUsage = {
  available: true,
  reason: null,
  schema: "codexbar.usage-snapshot/v1",
  generatedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  subscriptionTotalMonthlyUsd: 106,
  providers: [
    {
      id: "openai-codex",
      opencodeId: null,
      plan: null,
      planMonthlyUsd: null,
      usedPercent: 1,
      limited: false,
      maxed: false,
      resetsAt: null,
      updatedAt: null,
      error: null,
      windows: [],
      credits: null,
    },
  ],
};

const usageWithReset: CodexBarUsage = {
  ...usage,
  providers: [
    {
      ...usage.providers[0],
      usedPercent: 95,
      limited: true,
      windows: [
        {
          id: "codex-primary",
          title: "5時間",
          usedPercent: 95,
          resetsAt: null,
          windowMinutes: 300,
        },
      ],
      resetCreditsAvailable: 2,
    },
  ],
};

const accountUsage: CodexBarUsage = {
  ...usage,
  accounts: [
    {
      id: "acc-a",
      label: "仕事用",
      providers: ["openai-codex"],
      configuredProviders: ["openai-codex"],
    },
    {
      id: "acc-b",
      label: "個人用",
      providers: ["openai-codex"],
      configuredProviders: ["openai-codex"],
    },
  ],
  providers: [
    { ...usage.providers[0], accountId: "acc-a", accountLabel: "仕事用", usedPercent: 100 },
    { ...usage.providers[0], accountId: "acc-b", accountLabel: "個人用", usedPercent: 20 },
  ],
};

const SETTINGS_PATH = "/api/settings/codexbar-widget";
let serverSettings: string | null = null;
let otherGetResponse: unknown;

function setServerSettings(value: object) {
  serverSettings = JSON.stringify(value);
}

describe("CodexBarWidget", () => {
  it("shows used/total to the left of the summary percentage in either expansion state", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });
    useCodexUsage.mockReturnValue({ usage: { ...usage, providers: [{ ...usage.providers[0], usedPercent: 12, tokenUsage: {
      input: 700, output: 100, cacheRead: 150, cacheWrite: 50, totalTokens: 1000, responses: 1, startedAt: null,
      windows: [{ id: "provider", title: "利用枠", sampledTokens: 1000, sampledPercent: 2, tokensPerPercent: 500, estimatedRemainingTokens: 44000 }],
    } }] }, loadError: null, refreshing: false, refresh: vi.fn(), now: Date.now() });
    render(<CodexBarWidget />);
    const ratio = await screen.findByText("6K/50K");
    expect(ratio.nextElementSibling?.textContent).toBe("12%");
    expect(screen.queryByText(/実測|推定|tok\/1%/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Codex を最小化/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Codex を展開/ })).toBeTruthy());
    expect(screen.getByText("6K/50K").nextElementSibling?.textContent).toBe("12%");
  });
  it("embeds estimates in existing quota rows without a duplicate token section", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });
    const now = Date.now();
    const data = { ...usage, providers: [{ ...usage.providers[0], id: "commandcode", usedPercent: 91,
      windows: [{ id: "5h", title: "5時間", usedPercent: 39, resetsAt: null, windowMinutes: 300 },
        { id: "week", title: "週間", usedPercent: 91, resetsAt: null, windowMinutes: 10080 }],
      credits: { title: "クレジット", used: 32, limit: 70, balance: 38 },
      tokenUsage: { input: 246000000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 246000000, responses: 1, startedAt: null,
        windows: [
          { id: "5h", title: "5時間", sampledTokens: 455000, sampledPercent: 1, tokensPerPercent: 455000, estimatedRemainingTokens: 27900000, validUntil: new Date(now + 60000).toISOString() },
          { id: "week", title: "週間", sampledTokens: 5050000, sampledPercent: 1, tokensPerPercent: 5050000, estimatedRemainingTokens: 43300000 },
          { id: "credits", title: "クレジット", sampledTokens: 10100000, sampledPercent: 1, tokensPerPercent: 10100000, estimatedRemainingTokens: 549000000 },
        ] },
    }] };
    const hook = { usage: data, loadError: null, refreshing: false, refresh: vi.fn(), now };
    useCodexUsage.mockReturnValue(hook);
    const { rerender } = render(<CodexBarWidget />);
    const ratio = await screen.findByText("17.6M/45.5M");
    expect(ratio.parentElement?.textContent).toContain("5時間");
    expect(ratio.nextElementSibling?.textContent).toBe("39%");
    expect(screen.getAllByText("17.6M/45.5M")).toHaveLength(1);
    expect(screen.getByText("462M/505M").nextElementSibling?.textContent).toBe("91%");
    expect(screen.getByText("461M/1.01B").nextElementSibling?.textContent).toBe("46%");
    expect(screen.queryByText("246M tok")).toBeNull();
    expect(screen.queryByText(/実測|推定|tok\/1%|残≈/)).toBeNull();
    expect(screen.getByTitle(/455,000 tok\/1%/)).toBeTruthy();
    expect(screen.getByText("$32.00 / $70.00").closest("div")?.className).toContain("flex-wrap");
    useCodexUsage.mockReturnValue({ ...hook, now: now + 60000 });
    rerender(<CodexBarWidget />);
    expect(screen.queryByText("17.6M/45.5M")).toBeNull();
    expect(screen.getByText("462M/505M")).toBeTruthy();
  });
  it("never presents a display-only balance as a calibrated account quota", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });
    useCodexUsage.mockReturnValue({ usage: { ...usage, providers: [{ ...usage.providers[0], usedPercent: 12, usageDisplayOnly: true,
      windows: [{ id: "provider", title: "利用枠", usedPercent: 12, resetsAt: null, windowMinutes: 300 }],
      credits: { title: "クレジット", used: 1, limit: 2, balance: 1 },
      tokenUsage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, responses: 1, startedAt: null,
        windows: [{ id: "provider", title: "利用枠", sampledTokens: 1000, sampledPercent: 2, tokensPerPercent: 500, estimatedRemainingTokens: 44000 },
          { id: "credits", title: "クレジット", sampledTokens: 1000, sampledPercent: 2, tokensPerPercent: 500, estimatedRemainingTokens: 25000 }] },
    }] }, loadError: null, refreshing: false, refresh: vi.fn(), now: Date.now() });
    render(<CodexBarWidget />);
    expect(await screen.findByText("50%")).toBeTruthy();
    expect(screen.queryByText("6K/50K")).toBeNull();
    expect(screen.queryByText("25K/50K")).toBeNull();
  });
  it("shows the combined ratio at the parent percentage without borrowing one account's values", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: { "acc-a::openai-codex": true, "acc-b::openai-codex": true } });
    const tokenUsage = { input: 700, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, responses: 1, startedAt: null,
      windows: [{ id: "provider", title: "利用枠", sampledTokens: 1000, sampledPercent: 2, tokensPerPercent: 500, estimatedRemainingTokens: 40000 }] };
    useCodexUsage.mockReturnValue({ usage: { ...accountUsage, providers: accountUsage.providers.map((provider, index) => ({ ...provider,
      tokenUsage: { ...tokenUsage, windows: [{ ...tokenUsage.windows[0], estimatedRemainingTokens: index === 0 ? 0 : 40000 }] },
    })) }, loadError: null, refreshing: false, refresh: vi.fn(), now: Date.now() });
    render(<CodexBarWidget />);
    expect((await screen.findByText("60K/100K")).nextElementSibling?.textContent).toBe("60%");
    expect(screen.getByText("50K/50K").nextElementSibling?.textContent).toBe("100%");
    expect(screen.getByText("10K/50K").nextElementSibling?.textContent).toBe("20%");
    const accountRow = screen.getByRole("button", { name: "仕事用 を展開" });
    expect(accountRow.firstElementChild?.className).toContain("flex-1");
    expect(screen.getByText("50K/50K").parentElement?.className).toContain("shrink-0");
    expect(screen.queryByText(/実測|推定|tok\/1%/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "仕事用 を展開" }));
    expect(screen.getByText("60K/100K")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex を最小化" }));
    await waitFor(() => expect(screen.queryByText("50K/50K")).toBeNull());
    expect(screen.getByText("60K/100K")).toBeTruthy();
  });
  beforeEach(() => {
    localStorage.clear();
    resetWidgetSettingsCache();
    serverSettings = null;
    otherGetResponse = undefined;
    getJson.mockReset();
    getJson.mockImplementation(async (path: string) =>
      path === SETTINGS_PATH ? { value: serverSettings } : otherGetResponse,
    );    sendJson.mockReset();
    useCodexUsage.mockReturnValue({
      usage,
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });
    useCodexProviders.mockReturnValue({
      settingsOpen: false,
      providerSettings: null,
      settingsLoading: false,
      settingsError: null,
      settingsStatus: null,
      savingProviderId: null,
      savingProviderOrder: false,
      toggleProviderSettings: vi.fn(),
      toggleProviderEnabled: vi.fn(),
      reorderProviderSettings: vi.fn(),
      loadProviderSettings: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("defaults to the collapsed summary", () => {
    render(<CodexBarWidget />);

    expect(screen.getByRole("button", { name: "CodexBar 利用状況を開く" })).toBeTruthy();
    expect(screen.getByText("全体 1%")).toBeTruthy();
    expect(screen.queryByText("CodexBar 利用状況")).toBeNull();
  });

  it("groups accounts under one provider and displays their percentage", async () => {
    setServerSettings({ collapsed: false });
    useCodexUsage.mockReturnValue({
      usage: accountUsage,
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByText("60%")).toBeTruthy());
    expect(screen.queryByText(/表示中の合計/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Codex を展開" }));
    expect(screen.getByText("仕事用")).toBeTruthy();
    expect(screen.getByText("個人用")).toBeTruthy();
    expect(screen.getByText("仕事用").closest("button")?.querySelector("img")).toBeNull();
    expect(screen.getByText("仕事用").closest("ul")?.className).not.toContain("pl-6");
  });

  it("shows OpenRouter's global balance alongside one account, and exposes management errors", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });
    const global = {
      ...usage.providers[0],
      id: "openrouter",
      accountId: null,
      instanceId: "default:openrouter",
      credits: { title: "アカウント残高", used: 3, limit: 20, balance: 17 },
    };
    const account = {
      ...global,
      accountId: "acc-a",
      instanceId: "account:acc-a:openrouter",
      credits: { title: "キー利用枠", used: 1, limit: 5, balance: null },
    };
    const openrouterUsage = {
      ...usage,
      accounts: [{ id: "acc-a", label: "個人用", providers: ["openrouter"], configuredProviders: ["openrouter"] }],
      providers: [global, account],
    } as CodexBarUsage;
    useCodexUsage.mockReturnValue({
      usage: openrouterUsage,
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });

    const { rerender } = render(<CodexBarWidget />);
    expect(await screen.findByText("全体")).toBeTruthy();
    expect(screen.getByText("個人用")).toBeTruthy();
    expect(screen.getByText("残高 $17.00")).toBeTruthy();

    useCodexUsage.mockReturnValue({
      usage: { ...openrouterUsage, providers: [{ ...global, credits: null, usedPercent: null, error: "管理キーが無効です" }, account] },
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });
    rerender(<CodexBarWidget />);
    expect(screen.getByText("管理キーが無効です")).toBeTruthy();
  });

  it("flattens a provider with one account into a single row", async () => {
    setServerSettings({ collapsed: false, twoColumn: false });
    useCodexUsage.mockReturnValue({
      usage: {
        ...accountUsage,
        accounts: accountUsage.accounts?.slice(0, 1),
        providers: accountUsage.providers.slice(0, 1),
      },
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });

    render(<CodexBarWidget />);

    const accountLabel = await screen.findByText("仕事用");
    const serviceLabel = screen.getByText("Codex");
    expect(serviceLabel.className).toContain("flex-1");
    expect(accountLabel.className).toContain("flex-initial");
    expect(accountLabel.className).toContain("max-w-[40%]");
    expect(accountLabel.closest("button")?.className).toContain("min-w-0");
    expect(accountLabel.closest("button")?.textContent).toContain("Codex");
    expect(accountLabel.closest("li")?.querySelector("ul")).toBeNull();
    expect(screen.getAllByRole("list")).toHaveLength(1);
  });

  it("hides the account name in the narrow two-column card and keeps it in the title", async () => {
    setServerSettings({ collapsed: false });
    useCodexUsage.mockReturnValue({
      usage: {
        ...accountUsage,
        accounts: accountUsage.accounts?.slice(0, 1),
        providers: accountUsage.providers.slice(0, 1),
      },
      loadError: null,
      refreshing: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      now: Date.now(),
    });

    render(<CodexBarWidget />);

    const serviceLabel = await screen.findByText("Codex");
    expect(serviceLabel.title).toBe("Codex（仕事用）");
    expect(screen.queryByText("仕事用")).toBeNull();
  });

  it("keeps the saved expanded view compact with two columns and inline update status", async () => {
    setServerSettings({ collapsed: false });

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByText("CodexBar 利用状況")).toBeTruthy());

    const providerGrid = screen.getByRole("list");
    expect(providerGrid.className).toContain("grid-cols-2");
    expect(providerGrid.className).toContain("min-w-0");
    expect(providerGrid.className).toContain("items-stretch");
    const update = screen.getByText(/^更新 /);
    expect(update.parentElement?.className).toContain("border-b");
    expect(update.parentElement?.className).not.toContain("border-t");
  });

  it("forces a fresh usage fetch when the update button is clicked", async () => {
    setServerSettings({ collapsed: false });
    const refresh = vi.fn().mockResolvedValue(undefined);
    useCodexUsage.mockReturnValue({
      usage,
      loadError: null,
      refreshing: false,
      refresh,
      now: Date.now(),
    });

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByRole("button", { name: "更新" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(refresh).toHaveBeenCalledWith(true);
  });

  it("shows reset credit controls and does not POST when confirm is cancelled", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });
    const refresh = vi.fn().mockResolvedValue(undefined);
    useCodexUsage.mockReturnValue({
      usage: usageWithReset,
      loadError: null,
      refreshing: false,
      refresh,
      now: Date.parse("2026-09-14T00:00:00Z"),
    });
    otherGetResponse = {
      availableCount: 2,
      credits: [
        {
          id: "RateLimitResetCredit_later",
          title: "Full reset",
          expiresAt: "2026-10-01T00:00:00Z",
          status: "available",
        },
        {
          id: "RateLimitResetCredit_soon",
          title: "Full reset",
          expiresAt: "2026-09-20T00:00:00Z",
          status: "available",
        },
      ],
      accountId: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByText("CodexBar 利用状況")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("最短期限まであと6日")).toBeTruthy());
    expect(screen.getByText(/リセット権/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Codex の使用量リセット権を使う" }),
    );

    await waitFor(() =>
      expect(getJson.mock.calls.some(([path]) => path === "/api/codexbar/reset-credits")).toBe(true),
    );
    expect(confirmSpy).toHaveBeenCalled();
    expect(sendJson.mock.calls.some(([path]) => path === "/api/codexbar/reset-credits")).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
  it("migrates legacy localStorage settings to the server once", async () => {
    localStorage.setItem("webui:codexbar:collapsed", "0");
    localStorage.setItem("webui:codexbar:layout", "1");
    localStorage.setItem("webui:codexbar:providers", JSON.stringify({ "openai-codex": true }));

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByText("CodexBar 利用状況")).toBeTruthy());
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith(
        SETTINGS_PATH,
        {
          value: JSON.stringify({
            collapsed: false,
            twoColumn: false,
            providerCollapsed: { "openai-codex": true },
          }),
        },
        "PUT",
      ),
    );
    expect(localStorage.getItem("webui:codexbar:collapsed")).toBeNull();
    expect(localStorage.getItem("webui:codexbar:providers")).toBeNull();
  });

  it("saves the collapsed state to the server", async () => {
    setServerSettings({ collapsed: false, providerCollapsed: {} });

    render(<CodexBarWidget />);

    fireEvent.click(await screen.findByRole("button", { name: "折りたたむ" }));

    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith(
        SETTINGS_PATH,
        { value: JSON.stringify({ collapsed: true, providerCollapsed: {} }) },
        "PUT",
      ),
    );
    expect(localStorage.getItem("webui:codexbar:collapsed")).toBeNull();
  });
  it("does not overwrite server settings or drop legacy values when loading fails", async () => {
    localStorage.setItem("webui:codexbar:collapsed", "0");
    getJson.mockImplementation(async (path: string) => {
      if (path === SETTINGS_PATH) throw new Error("offline");
      return otherGetResponse;
    });

    render(<CodexBarWidget />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith(SETTINGS_PATH));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendJson.mock.calls.some(([path]) => path === SETTINGS_PATH)).toBe(false);
    expect(localStorage.getItem("webui:codexbar:collapsed")).toBe("0");
  });

  it("merges changes made before loading with the server value", async () => {
    let resolveSettings: (value: unknown) => void = () => undefined;
    getJson.mockImplementation((path: string) =>
      path === SETTINGS_PATH
        ? new Promise((resolve) => {
            resolveSettings = resolve;
          })
        : Promise.resolve(otherGetResponse),
    );

    render(<CodexBarWidget />);
    fireEvent.click(screen.getByRole("button", { name: "CodexBar 利用状況を開く" }));
    expect(sendJson).not.toHaveBeenCalled();

    resolveSettings({ value: JSON.stringify({ twoColumn: false, providerCollapsed: {} }) });

    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith(
        SETTINGS_PATH,
        { value: JSON.stringify({ twoColumn: false, providerCollapsed: {}, collapsed: false }) },
        "PUT",
      ),
    );
  });
});