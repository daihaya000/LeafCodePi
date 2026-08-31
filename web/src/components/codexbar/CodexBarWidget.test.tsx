// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBarUsage } from "@/lib/codexbar";
import { CodexBarWidget } from "./CodexBarWidget";

const { useCodexUsage, useCodexProviders } = vi.hoisted(() => ({
  useCodexUsage: vi.fn(),
  useCodexProviders: vi.fn(),
}));

vi.mock("./use-codex-usage", () => ({ useCodexUsage }));
vi.mock("./use-codex-providers", () => ({ useCodexProviders }));

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

describe("CodexBarWidget", () => {
  beforeEach(() => {
    localStorage.clear();
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
    localStorage.setItem("webui:codexbar:collapsed", "0");
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
    fireEvent.click(screen.getByRole("button", { name: "Codex を展開" }));
    expect(screen.getByText("仕事用")).toBeTruthy();
    expect(screen.getByText("個人用")).toBeTruthy();
    expect(screen.getByText("仕事用").closest("button")?.querySelector("img")).toBeNull();
    expect(screen.getByText("仕事用").closest("ul")?.className).not.toContain("pl-6");
  });

  it("keeps the saved expanded view compact with two columns and inline update status", async () => {
    localStorage.setItem("webui:codexbar:collapsed", "0");

    render(<CodexBarWidget />);

    await waitFor(() => expect(screen.getByText("CodexBar 利用状況")).toBeTruthy());

    expect(screen.getByRole("list").className).toContain("grid-cols-2");
    const update = screen.getByText(/^更新 /);
    expect(update.parentElement?.className).toContain("border-b");
    expect(update.parentElement?.className).not.toContain("border-t");
  });
});
