// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderTokenUsage } from "@/lib/codexbar/token-usage-types";
import { TokenUsageDetails } from "./TokenUsageDetails";

const usage: ProviderTokenUsage = { input: 700, output: 100, cacheRead: 150, cacheWrite: 50, totalTokens: 1000, responses: 1,
  startedAt: "2026-10-07T10:00:00Z", windows: [{ id: "5h", title: "5時間", sampledTokens: 1000, sampledPercent: 2,
    tokensPerPercent: 500, estimatedRemainingTokens: 44000 }] };
afterEach(cleanup);
describe("TokenUsageDetails", () => {
  it("renders actual, estimated remaining and tokens per percentage point with caveats", () => {
    render(<TokenUsageDetails usage={usage} />);
    expect(screen.getByText("1,000 tok")).toBeTruthy();
    expect(screen.getByText("推定残 44,000 tok")).toBeTruthy();
    expect(screen.getByText("· 500 tok/1%")).toBeTruthy();
    expect(screen.getByTitle(/保証された残量ではない/)).toBeTruthy();
    expect(screen.getByTitle(/外部CLI・補助呼出・中断応答は含まない/)).toBeTruthy();
  });
  it("does not invent a quota before calibration", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], tokensPerPercent: null, estimatedRemainingTokens: null }] }} />);
    expect(screen.getByText(/推定 —/)).toBeTruthy();
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.queryByText(/tok\/1%/)).toBeNull();
  });
});
