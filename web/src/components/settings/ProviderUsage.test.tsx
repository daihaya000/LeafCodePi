// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBarProvider, CodexBarWindow } from "@/lib/codexbar";
import { ProviderUsage } from "./ProviderUsage";

const usage: CodexBarProvider = {
  id: "openai-codex",
  opencodeId: "openai-codex",
  plan: null,
  planMonthlyUsd: null,
  usedPercent: 72,
  limited: false,
  maxed: false,
  resetsAt: null,
  updatedAt: null,
  error: null,
  windows: [],
  credits: null,
};

function window(title: string, usedPercent: number | null, resetsAt: string | null = null): CodexBarWindow {
  return { id: title, title, usedPercent, resetsAt, windowMinutes: null };
}

function fill(title: string) {
  return screen.getByRole("progressbar", { name: title }).firstElementChild as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ProviderUsage", () => {
  it("shows separate Codex windows instead of their aggregate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    render(<ProviderUsage usage={{ ...usage, windows: [
      window("5時間", 12, "2026-10-05T14:00:00Z"),
      window("週間", 72, "2026-10-08T12:00:00Z"),
    ] }} />);

    expect(screen.getByText("12%")).toBeTruthy();
    expect(screen.getByText("72%")).toBeTruthy();
    expect(fill("5時間").style.width).toBe("12%");
    expect(fill("週間").style.width).toBe("72%");
    expect(screen.getByText("リセット 2時間後")).toBeTruthy();
    expect(screen.getByText("リセット 3日後")).toBeTruthy();
    expect(screen.queryByText("使用量")).toBeNull();
  });

  it.each([
    ["anthropic", ["5時間", "週間", "週間 (Sonnet)"]],
    ["opencode-go", ["5時間", "週間", "月間"]],
    ["ollama-cloud", ["セッション", "週間"]],
    ["cursor", ["プラン", "Auto", "API", "オンデマンド"]],
  ])("preserves all %s period and breakdown labels", (id, titles) => {
    render(<ProviderUsage usage={{ ...usage, id, windows: titles.map((title) => window(title, 20)) }} />);
    expect(screen.getAllByRole("progressbar").map((bar) => bar.getAttribute("aria-label"))).toEqual(titles);
  });

  it("calculates colors per window and clamps bar widths, not displayed percentages", () => {
    render(<ProviderUsage usage={{ ...usage, windows: [
      window("5時間", 5), window("週間", 80), window("月間", 125), window("日間", -3),
    ] }} />);
    expect(fill("5時間").className).toContain("bg-success");
    expect(fill("週間").className).toContain("bg-warning");
    expect(fill("月間").className).toContain("bg-danger");
    expect(fill("月間").style.width).toBe("100%");
    expect(fill("日間").style.width).toBe("0%");
    expect(screen.getByText("125%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "月間" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("keeps unknown windows visible without inventing a percentage or reset", () => {
    render(<ProviderUsage usage={{ ...usage, windows: [window("週間", null, "invalid")] }} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(fill("週間").style.width).toBe("0%");
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByText(/リセット/)).toBeNull();
  });

  it("falls back to aggregate usage for older snapshots without windows", () => {
    render(<ProviderUsage usage={{ ...usage, windows: undefined } as unknown as CodexBarProvider} />);
    expect(fill("使用量").style.width).toBe("72%");
  });

  it("does not show an unknown usage bar for credit-only accounts", () => {
    const { container } = render(<ProviderUsage usage={{ ...usage, usedPercent: null, credits: {
      title: "クレジット", used: null, limit: null, balance: 10,
    } }} />);
    expect(container.textContent).toBe("");
  });

  it("shows an unknown aggregate when neither windows nor credits are available", () => {
    render(<ProviderUsage usage={{ ...usage, usedPercent: null }} />);
    expect(screen.getByText("使用量")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
