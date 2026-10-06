import { describe, expect, it, vi } from "vitest";
import { createTaskStreamWake, TASK_STREAM_WAKE_MS } from "./task-stream-wake";

describe("createTaskStreamWake", () => {
  it("wakes at once, then at most once per interval with a trailing wake", () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      expect(TASK_STREAM_WAKE_MS).toBe(300);
      const publish = createTaskStreamWake({ emit });
      publish("task-1");
      expect(emit).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 10; index += 1) {
        vi.advanceTimersByTime(30);
        publish("task-1");
      }
      // Continuous streaming is capped at ~3.3 wakes/s, with a trailing wake for the final text.
      expect(emit).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(TASK_STREAM_WAKE_MS);
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
      const publish = createTaskStreamWake({ emit });
      publish("a");
      publish("b");
      publish("a");
      expect(emit.mock.calls).toEqual([["a"], ["b"]]);
      vi.advanceTimersByTime(TASK_STREAM_WAKE_MS);
      expect(emit.mock.calls).toEqual([["a"], ["b"], ["a"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
