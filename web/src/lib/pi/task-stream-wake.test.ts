import { describe, expect, it, vi } from "vitest";
import { createTaskStreamWake } from "./task-stream-wake";

describe("createTaskStreamWake", () => {
  it("wakes at once, then at most once per interval with a trailing wake", () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const publish = createTaskStreamWake({ emit, intervalMs: 200 });
      publish("task-1");
      expect(emit).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 10; index += 1) {
        vi.advanceTimersByTime(20);
        publish("task-1");
      }
      // Ten updates in 200ms: one throttled wake at 200ms, plus a trailing one armed by the last.
      expect(emit).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(200);
      expect(emit).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1_000);
      expect(emit).toHaveBeenCalledTimes(3);
      // A quiet period resets the throttle: the next update wakes immediately.
      publish("task-1");
      expect(emit).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles tasks independently", () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const publish = createTaskStreamWake({ emit, intervalMs: 200 });
      publish("a");
      publish("b");
      publish("a");
      expect(emit.mock.calls).toEqual([["a"], ["b"]]);
      vi.advanceTimersByTime(200);
      expect(emit.mock.calls).toEqual([["a"], ["b"], ["a"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
