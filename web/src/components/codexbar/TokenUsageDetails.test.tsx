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
    expect(screen.getByText("1K tok")).toBeTruthy();
    expect(screen.getByText("推定残 44K tok")).toBeTruthy();
    expect(screen.getByText("· 500 tok/1%")).toBeTruthy();
    expect(screen.getByTitle(/保証された残量ではない/)).toBeTruthy();
    expect(screen.getByTitle(/外部CLI・補助呼出・中断応答は含まない/)).toBeTruthy();
  });
  it.each([
    [0, "0"], [999, "999"], [999.5, "1K"], [1000, "1K"], [1500, "1.5K"],
    [760449, "760K"], [999999, "1M"], [23827402, "23.8M"], [64638165, "64.6M"],
    [999999999, "1B"], [1000000000, "1B"],
  ] as const)("compacts %s tokens as %s without long boundary labels", (value, label) => {
    render(<TokenUsageDetails usage={{ ...usage, totalTokens: value, windows: [] }} />);
    expect(screen.getByText(`${label} tok`)).toBeTruthy();
  });
  it("compacts all visible counts but preserves detailed values in tooltips", () => {
    render(<TokenUsageDetails usage={{ ...usage, totalTokens: 760449, windows: [{ ...usage.windows[0], estimatedRemainingTokens: 23827402, tokensPerPercent: 253483 }] }} />);
    expect(screen.getByText("760K tok")).toBeTruthy();
    expect(screen.getByText("推定残 23.8M tok")).toBeTruthy();
    expect(screen.getByText("· 253K tok/1%")).toBeTruthy();
    expect(screen.getByTitle(/実測 760,449 tok/)).toBeTruthy();
    expect(screen.getByTitle(/推定残 23,827,402 tok \/ 253,483 tok\/1%/)).toBeTruthy();
  });
  it("does not round a positive sub-token rate down to zero", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], sampledTokens: 1, sampledPercent: 100, tokensPerPercent: 0.01, estimatedRemainingTokens: 0 }] }} />);
    expect(screen.getByText("· 0.01 tok/1%")).toBeTruthy();
  });
  it("expires an already-rendered estimate without waiting for the next provider poll", () => {
    const data = { ...usage, windows: [{ ...usage.windows[0], status: "ready" as const, validUntil: "2026-10-07T10:15:00Z" }] };
    const { rerender } = render(<TokenUsageDetails usage={data} now={Date.parse("2026-10-07T10:14:00Z")} />);
    expect(screen.getByText("推定残 44K tok")).toBeTruthy();
    rerender(<TokenUsageDetails usage={data} now={Date.parse("2026-10-07T10:15:00Z")} />);
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.getByText("· 推定なし")).toBeTruthy();
    expect(screen.getByTitle(/古い取得値/)).toBeTruthy();
  });
  it.each([
    ["unsupported", "この利用枠は推定対象外"],
    ["expired", "リセット期限経過"],
    ["invalid", "使用率・日時を取得できない"],
  ] as const)("explains %s instead of asking for impossible calibration", (status, label) => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], status }] }} />);
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.getByText("· 推定なし")).toBeTruthy();
    expect(screen.getByTitle(`5時間: ${label}`)).toBeTruthy();
    expect(screen.queryByText(label)).toBeNull();
  });
  it("collapses repeated uncalibrated windows into a single inline hint", () => {
    const uncalibrated = { ...usage.windows[0], status: "calibrating" as const, tokensPerPercent: null, estimatedRemainingTokens: null };
    const { container } = render(<TokenUsageDetails usage={{ ...usage, totalTokens: 0, windows: [uncalibrated, { ...uncalibrated, id: "week", title: "週間" }] }} />);
    expect(container.textContent).toBe("実測 0 tok· 推定待ち");
    expect(screen.getAllByText("· 推定待ち")).toHaveLength(1);
    expect(screen.getByText("· 推定待ち").getAttribute("title")).toBe("5時間: 計測中／使用率差1%以上が必要\n週間: 計測中／使用率差1%以上が必要");
    expect(screen.queryByText(/使用率差1%以上/)).toBeNull();
  });
  it("keeps calibrated numbers while summarizing only pending windows", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [usage.windows[0], { ...usage.windows[0], id: "week", title: "週間", tokensPerPercent: null, estimatedRemainingTokens: null }] }} />);
    expect(screen.getByText("推定残 44K tok")).toBeTruthy();
    expect(screen.getByText("· 推定待ち")).toBeTruthy();
    expect(screen.getByTitle("週間: 計測中／使用率差1%以上が必要")).toBeTruthy();
    expect(screen.queryByText("週間:")).toBeNull();
  });
  it("does not show a pending hint when there are no quota windows", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [] }} />);
    expect(screen.queryByText(/推定/)).toBeNull();
    expect(screen.getByText("1K tok")).toBeTruthy();
  });
  it("does not invent a quota before calibration", () => {
    render(<TokenUsageDetails usage={{ ...usage, windows: [{ ...usage.windows[0], tokensPerPercent: null, estimatedRemainingTokens: null }] }} />);
    expect(screen.getByText("· 推定待ち")).toBeTruthy();
    expect(screen.queryByText(/推定残/)).toBeNull();
    expect(screen.queryByText(/tok\/1%/)).toBeNull();
  });
});
