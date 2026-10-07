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
  it("does not round a positive sub-token rate down to zero", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], sampledTokens: 1, sampledPercent: 100, tokensPerPercent: 0.01, estimatedRemainingTokens: 0 }] }} />);
    expect(screen.getByText("· 0.01 tok/1%")).toBeTruthy();
  });
  it("expires an already-rendered estimate without waiting for the next provider poll", () => {
    const data = { ...usage, windows: [{ ...usage.windows[0], status: "ready" as const, validUntil: "2026-10-07T10:15:00Z" }] };
    const { rerender } = render(<TokenUsageDetails usage={data} now={Date.parse("2026-10-07T10:14:00Z")} />);
    expect(screen.getByText("推定残 44,000 tok")).toBeTruthy();
    rerender(<TokenUsageDetails usage={data} now={Date.parse("2026-10-07T10:15:00Z")} />);
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.getByText(/古い取得値/)).toBeTruthy();
  });
  it.each([
    ["unsupported", "この利用枠は推定対象外"],
    ["expired", "リセット期限経過"],
    ["invalid", "使用率・日時を取得できない"],
  ] as const)("explains %s instead of asking for impossible calibration", (status, label) => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], status }] }} />);
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.getByText(`推定 —（${label}）`)).toBeTruthy();
  });
  it("does not invent a quota before calibration", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], tokensPerPercent: null, estimatedRemainingTokens: null }] }} />);
    expect(screen.getByText(/推定 —/)).toBeTruthy();
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.queryByText(/tok\/1%/)).toBeNull();
  });
});
