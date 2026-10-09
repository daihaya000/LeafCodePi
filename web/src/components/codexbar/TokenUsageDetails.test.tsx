// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexBarSnapshot } from "@/lib/codexbar";
import type { TokenUsageEstimate } from "@/lib/codexbar/token-usage-types";
import { TokenEstimateInline, summaryTokenEstimate } from "./TokenUsageDetails";

const estimate: TokenUsageEstimate = { id: "provider", title: "利用枠", sampledTokens: 1000, sampledPercent: 2,
  tokensPerPercent: 500, estimatedRemainingTokens: 44000 };
const now = Date.parse("2026-10-09T10:00:00Z");
const base = parseCodexBarSnapshot({ providers: [{ codexBarProviderId: "openai-codex", usedPercent: 12 }] }).providers[0];
const usage = { input: 700, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, responses: 1, startedAt: null,
  windows: [estimate] };
afterEach(cleanup);

describe("TokenEstimateInline", () => {
  it("shows only used/total, not remaining, lifetime actual tokens, labels or repeated units", () => {
    const { container } = render(<TokenEstimateInline estimate={estimate} now={now} />);
    expect(container.textContent).toBe("6K/50K");
    expect(container.querySelector("span")?.title).toContain("利用済 6,000 tok / 合計 50,000 tok / 500 tok/1%");
    expect(container.querySelector("span")?.title).toContain("保証された残量ではない");
  });
  it.each([
    [0, "0"], [999, "999"], [999.5, "1K"], [1000, "1K"], [1500, "1.5K"],
    [760449, "760K"], [999999, "1M"], [23827402, "23.8M"], [999999999, "1B"],
  ] as const)("compacts %s used tokens as %s", (used, label) => {
    const total = Math.max(1, used) * 2;
    const { container } = render(<TokenEstimateInline estimate={{ ...estimate, estimatedTotalTokens: total, estimatedRemainingTokens: total - used }} now={now} />);
    expect(container.textContent?.startsWith(`${label}/`)).toBe(true);
  });
  it("uses explicitly aggregated capacity without inventing a conversion rate", () => {
    const { container } = render(<TokenEstimateInline estimate={{ ...estimate, tokensPerPercent: null,
      estimatedTotalTokens: 100000, estimatedRemainingTokens: 40000 }} now={now} />);
    expect(container.textContent).toBe("60K/100K");
    expect(container.querySelector("span")?.title).not.toContain("tok/1%");
  });
  it("preserves sub-token rates in the tooltip", () => {
    const { container } = render(<TokenEstimateInline estimate={{ ...estimate, tokensPerPercent: 0.01, estimatedRemainingTokens: 0 }} now={now} />);
    expect(container.textContent).toBe("1/1");
    expect(container.querySelector("span")?.title).toContain("0.01 tok/1%");
  });
  it("expires a rendered ratio at its deadline", () => {
    const data = { ...estimate, validUntil: new Date(now + 60000).toISOString() };
    const { container, rerender } = render(<TokenEstimateInline estimate={data} now={now} />);
    expect(container.textContent).toBe("6K/50K");
    rerender(<TokenEstimateInline estimate={data} now={now + 60000} />);
    expect(container.textContent).toBe("");
  });
  it.each(["calibrating", "unsupported", "stale", "expired", "invalid"] as const)("hides %s without visible hints", (status) => {
    const { container } = render(<TokenEstimateInline estimate={{ ...estimate, status }} now={now} />);
    expect(container.textContent).toBe("");
  });
  it.each([
    { tokensPerPercent: null }, { estimatedRemainingTokens: null }, { estimatedRemainingTokens: -1 },
    { estimatedRemainingTokens: 50001 }, { estimatedRemainingTokens: Infinity },
    { estimatedTotalTokens: NaN }, { estimatedTotalTokens: 0 }, { validUntil: "invalid" },
  ])("hides invalid or missing capacity: %j", (override) => {
    const { container } = render(<TokenEstimateInline estimate={{ ...estimate, ...override }} now={now} />);
    expect(container.textContent).toBe("");
  });
  it("renders nothing without telemetry", () => {
    const { container } = render(<TokenEstimateInline now={now} />);
    expect(container.textContent).toBe("");
  });
});

describe("summaryTokenEstimate", () => {
  it("selects the exact counted window behind the summary, not an overlapping rounded match", () => {
    const primary = { ...estimate, id: "5h" };
    const weekly = { ...estimate, id: "week" };
    const provider = { ...base, usedPercent: 90.49, tokenUsage: { ...usage, windows: [primary, weekly] }, windows: [
      { id: "5h", title: "5時間", usedPercent: 90.4, resetsAt: null, windowMinutes: 300 },
      { id: "week", title: "週間", usedPercent: 90.49, resetsAt: null, windowMinutes: 10080 },
    ] };
    expect(summaryTokenEstimate(provider)).toBe(weekly);
    expect(summaryTokenEstimate({ ...provider, windows: provider.windows.map((window) => ({ ...window, countsTowardLimit: false })) })).toBeUndefined();
  });
  it("selects the generic window for a provider without separate windows or credits", () => {
    expect(summaryTokenEstimate({ ...base, tokenUsage: usage })).toBe(estimate);
  });
  it("selects credits only when the credit percentage actually matches the summary", () => {
    const credits = { ...estimate, id: "credits" };
    const provider = { ...base, usedPercent: 50, credits: { title: "クレジット", used: 1, limit: 2, balance: 1 },
      tokenUsage: { ...usage, windows: [credits] } };
    expect(summaryTokenEstimate(provider)).toBe(credits);
    expect(summaryTokenEstimate({ ...provider, usedPercent: 60 })).toBeUndefined();
  });
  it("does not display unknown, display-only or stale summaries", () => {
    expect(summaryTokenEstimate({ ...base, tokenUsage: usage, usedPercent: null })).toBeUndefined();
    expect(summaryTokenEstimate({ ...base, tokenUsage: usage, usageDisplayOnly: true })).toBeUndefined();
    expect(summaryTokenEstimate({ ...base, tokenUsage: usage, stale: true })).toBeUndefined();
  });
});
