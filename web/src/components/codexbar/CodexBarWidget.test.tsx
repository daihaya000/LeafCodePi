// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  subscriptionTotalMonthlyUsd: null,
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
      toggleProviderSettings: vi.fn(),
      toggleProviderEnabled: vi.fn(),
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
    expect(screen.queryByText("CodexBar 利用状況")).toBeNull();
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
