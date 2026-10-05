// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_STREAM_THROTTLE_MS, useThrottledText } from "./PartView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useThrottledText", () => {
  it("shows the first text immediately and coalesces a burst into one trailing update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, rerender } = renderHook(({ text }) => useThrottledText(text, MARKDOWN_STREAM_THROTTLE_MS), {
      initialProps: { text: "a" },
    });
    expect(result.current).toBe("a");

    // The first change is old enough to apply at once.
    await act(async () => { rerender({ text: "ab" }); });
    expect(result.current).toBe("ab");

    // Following tokens inside the window are held back, then only the latest lands.
    await act(async () => { rerender({ text: "abc" }); });
    await act(async () => { rerender({ text: "abcd" }); });
    expect(result.current).toBe("ab");
    await act(async () => { await vi.advanceTimersByTimeAsync(MARKDOWN_STREAM_THROTTLE_MS); });
    expect(result.current).toBe("abcd");
  });
});
