import { describe, expect, it, vi } from "vitest";
import {
  cancelPendingSseReconnect,
  closeSseSource,
  sseReconnectDelayMs,
} from "./sse-reconnect";

describe("sse reconnect", () => {
  it("backs off and caps delay", () => {
    expect(sseReconnectDelayMs(1)).toBe(1000);
    expect(sseReconnectDelayMs(2)).toBe(2000);
    expect(sseReconnectDelayMs(5)).toBe(15000);
    expect(sseReconnectDelayMs(9)).toBe(15000);
  });

  it("cancels a previous reconnect timer before another error can stack", () => {
    const clearTimer = vi.fn();
    const first = 11 as unknown as ReturnType<typeof setTimeout>;
    expect(cancelPendingSseReconnect(first, clearTimer)).toBeNull();
    expect(clearTimer).toHaveBeenCalledWith(first);
    expect(cancelPendingSseReconnect(null, clearTimer)).toBeNull();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("closes the current EventSource before a replacement connect", () => {
    const close = vi.fn();
    expect(closeSseSource({ close })).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(closeSseSource(null)).toBeNull();
  });
});
