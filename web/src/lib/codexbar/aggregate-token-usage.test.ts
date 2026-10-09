import { describe, expect, it } from "vitest";
import { parseCodexBarSnapshot, type CodexBarProviderGroup } from "@/lib/codexbar";
import type { ProviderTokenUsage } from "./token-usage-types";
import { aggregateTokenUsage } from "./aggregate-token-usage";

const provider = parseCodexBarSnapshot({ providers: [{ codexBarProviderId: "openai-codex", usedPercent: 20 }] }).providers[0];
function measurement(totalTokens = 1000, remaining = 40000): ProviderTokenUsage {
  return { input: totalTokens - 300, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens, responses: 1,
    startedAt: "2026-10-08T00:00:00Z", windows: [{ id: "5h", title: "5時間", status: "ready",
      validUntil: "2026-10-08T01:00:00Z", sampledTokens: 1000, sampledPercent: 2, tokensPerPercent: 500,
      estimatedRemainingTokens: remaining }] };
}
function group(...values: (ProviderTokenUsage | undefined)[]): CodexBarProviderGroup {
  return { id: provider.id, provider, limitedCount: 0, maxedCount: 0,
    accountRows: values.map((tokenUsage, index) => ({ id: String(index), label: String(index), configured: true,
      provider: { ...provider, accountId: String(index), tokenUsage } })) };
}

describe("aggregateTokenUsage", () => {
  it("sums actual tokens and calibrated remaining tokens, not percentages or calibration rates", () => {
    const source = group(measurement(), measurement(2000, 20000));
    const before = structuredClone(source);
    const result = aggregateTokenUsage(source)!;
    expect(result).toMatchObject({ measuredAccounts: 2, totalAccounts: 2,
      usage: { input: 2400, output: 600, totalTokens: 3000, responses: 2,
        windows: [{ status: "ready", estimatedRemainingTokens: 60000, estimatedTotalTokens: 100000, tokensPerPercent: null }] } });
    expect(source).toEqual(before);
    expect(source.provider.tokenUsage).toBeUndefined();
  });
  it("marks missing account telemetry as partial and withholds a misleading partial remaining sum", () => {
    const result = aggregateTokenUsage(group(measurement(), undefined))!;
    expect(result).toMatchObject({ measuredAccounts: 1, totalAccounts: 2, usage: { totalTokens: 1000,
      windows: [{ status: "invalid", estimatedRemainingTokens: null }] } });
  });
  it.each(["calibrating", "unsupported", "stale", "expired", "invalid"] as const)("withholds the sum when an account is %s", (status) => {
    const unready = measurement();
    unready.windows[0] = { ...unready.windows[0], status, estimatedRemainingTokens: null, tokensPerPercent: null };
    expect(aggregateTokenUsage(group(measurement(), unready))!.usage.windows[0]).toMatchObject({ status, estimatedRemainingTokens: null });
  });
  it("does not turn an account's absent quota window into zero remaining tokens", () => {
    expect(aggregateTokenUsage(group(measurement(), { ...measurement(), windows: [] }))!.usage.windows[0])
      .toMatchObject({ status: "invalid", estimatedRemainingTokens: null });
  });
  it("keeps the earliest measurement start and the shortest estimate deadline", () => {
    const second = measurement();
    second.startedAt = "2026-10-07T00:00:00Z";
    second.windows[0].validUntil = "2026-10-08T00:30:00Z";
    const result = aggregateTokenUsage(group(measurement(), second))!.usage;
    expect(Date.parse(result.startedAt!)).toBe(Date.parse(second.startedAt!));
    expect(Date.parse(result.windows[0].validUntil!)).toBe(Date.parse(second.windows[0].validUntil!));
  });
  it("rejects invalid estimate deadlines", () => {
    const invalid = measurement();
    invalid.windows[0].validUntil = "invalid";
    expect(aggregateTokenUsage(group(measurement(), invalid))!.usage.windows[0])
      .toMatchObject({ status: "invalid", estimatedRemainingTokens: null });
  });
  it("excludes logged-out accounts but not their configured peers", () => {
    const source = group(measurement(), undefined);
    source.accountRows[1].configured = false;
    expect(aggregateTokenUsage(source)).toMatchObject({ measuredAccounts: 1, totalAccounts: 1,
      usage: { windows: [{ status: "ready", estimatedRemainingTokens: 40000 }] } });
  });
  it("never adds a display-only global balance as an independent account quota", () => {
    const source = group(measurement(), measurement(2000, 90000));
    source.accountRows[1].provider!.usageDisplayOnly = true;
    expect(aggregateTokenUsage(source)!.usage).toMatchObject({ totalTokens: 3000,
      windows: [{ estimatedRemainingTokens: 40000 }] });
  });
  it("sums explicit capacities instead of recalibrating from the parent average", () => {
    const a = measurement(), b = measurement(2000, 20000);
    a.windows[0].estimatedTotalTokens = 50000;
    b.windows[0].estimatedTotalTokens = 100000;
    expect(aggregateTokenUsage(group(a, b))!.usage.windows[0]).toMatchObject({
      status: "ready", estimatedRemainingTokens: 60000, estimatedTotalTokens: 150000, tokensPerPercent: null,
    });
  });
  it.each([0, -1, Infinity, NaN, 39999])("withholds the aggregate when one capacity is invalid: %s", (capacity) => {
    const bad = measurement();
    bad.windows[0].estimatedTotalTokens = capacity;
    expect(aggregateTokenUsage(group(measurement(), bad))!.usage.windows[0].estimatedTotalTokens).toBeNull();
  });
  it("does not invent a measured zero before any account reports telemetry", () => {
    expect(aggregateTokenUsage(group(undefined, undefined))).toBeNull();
  });
});
