// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBarUsage } from "@/lib/codexbar";
import { useCodexUsage } from "./use-codex-usage";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson }));

const usage: CodexBarUsage = {
  available: true,
  reason: null,
  schema: null,
  generatedAt: null,
  subscriptionTotalMonthlyUsd: null,
  providers: [],
};

describe("useCodexUsage", () => {
  beforeEach(() => {
    getJson.mockReset();
    getJson.mockResolvedValue(usage);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fetches exactly once on mount even when expanded (coalesced)", async () => {
    const { result } = renderHook(() => useCodexUsage({ enabled: true }));
    await act(async () => {});
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(result.current.usage).toEqual(usage);
  });

  it("refetches when expanded after being collapsed past the stale threshold", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ enabled }) => useCodexUsage({ enabled }), {
      initialProps: { enabled: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getJson).toHaveBeenCalledTimes(1);

    // 折りたたみ中はポーリングしない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(getJson).toHaveBeenCalledTimes(1);

    // 展開時点でスナップショットが古いので即再取得する
    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getJson).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on expand while the snapshot is fresh", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ enabled }) => useCodexUsage({ enabled }), {
      initialProps: { enabled: true },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getJson).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    rerender({ enabled: true }); // 直後に展開: データはまだ新鮮
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getJson).toHaveBeenCalledTimes(1);
  });
});
